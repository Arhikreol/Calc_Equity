(function () {
  "use strict";

  const DEFAULT_BASE_STAKE = 1.0;
  const DEFAULT_PAYOUT_PCT = 92.0;
  const DEFAULT_RESET_AFTER_LOSSES = 3;
  const DEFAULT_LOSS_MULT = 3.0;
  const DEFAULT_MAX_DRAWDOWN_CAP = 100.0;
  const DEFAULT_KELLY_START_DEPOSIT = 100.0;
  const DEFAULT_KELLY_POSITION_PCT = 2.0;
  const RESET_AFTER_LOSSES_MIN = 2;
  const RESET_AFTER_LOSSES_MAX = 10;
  const LOSS_MULT_MIN = 1.0;
  const LOSS_MULT_MAX = 10.0;
  const LOSS_MULT_STEP = 0.1;
  const KELLY_MIN_STAKE = 1.0;
  const KELLY_START_DEPOSIT_MIN = 1.0;
  const KELLY_POSITION_PCT_MIN = 0.1;
  const KELLY_POSITION_PCT_MAX = 10.0;
  const EPSILON = 1e-9;

  const dom = {
    fileInput: document.getElementById("xlsxFile"),
    resetAfterLosses: document.getElementById("resetAfterLosses"),
    resetAfterLossesValue: document.getElementById("resetAfterLossesValue"),
    lossMult: document.getElementById("lossMult"),
    lossMultValue: document.getElementById("lossMultValue"),
    lossMultSequenceFields: document.getElementById("lossMultSequenceFields"),
    maxDrawdownCap: document.getElementById("maxDrawdownCap"),
    kellyStartDeposit: document.getElementById("kellyStartDeposit"),
    kellyPositionPct: document.getElementById("kellyPositionPct"),
    kellyPositionPctValue: document.getElementById("kellyPositionPctValue"),
    autoBestButton: document.getElementById("autoBestButton"),
    statusBanner: document.getElementById("statusBanner"),
    chartTitle: document.getElementById("chartTitle"),
    chartSummary: document.getElementById("chartSummary"),
    chartSurface: document.querySelector(".chart-surface"),
    chartCanvas: document.getElementById("equityChart"),
    chartEmptyState: document.getElementById("chartEmptyState"),
    manualBreakApplyButton: document.getElementById("manualBreakApplyButton"),
    manualBreakUndoButton: document.getElementById("manualBreakUndoButton"),
    manualBreakCount: document.getElementById("manualBreakCount"),
    statsGrid: document.getElementById("statsGrid"),
    visitCounterOverall: document.getElementById("visitCounterOverall"),
    visitCounterToday: document.getElementById("visitCounterToday"),
    visitCounterNote: document.getElementById("visitCounterNote"),
    sourceFileName: document.getElementById("sourceFileName"),
    sourceTradeCount: document.getElementById("sourceTradeCount"),
    sourceRowCount: document.getElementById("sourceRowCount"),
  };

  const state = {
    busy: false,
    source: {
      fileName: "Файл не загружен",
      sheetName: "-",
      rowCount: 0,
      tradeCount: 0,
    },
    sequence: [],
    sequenceSummary: emptySequenceSummary(),
    config: buildConfig(DEFAULT_RESET_AFTER_LOSSES, DEFAULT_LOSS_MULT),
    kellyConfig: buildKellyConfig(DEFAULT_KELLY_START_DEPOSIT, DEFAULT_KELLY_POSITION_PCT),
    actualCurve: null,
    actualFitEquityValues: null,
    effectiveSequence: [],
    manualBreakIndices: [],
    manualBreakCandidateIndices: [],
    baselinePayload: null,
    payload: null,
    kellyPayload: null,
  };
  let pendingChartFrame = 0;

  function init() {
    if (typeof window.XLSX === "undefined") {
      setStatus("Не удалось загрузить библиотеку SheetJS. Проверьте `vendor/xlsx.full.min.js`.", "error");
      setBusy(true);
      return;
    }

    dom.resetAfterLosses.addEventListener("input", handleControlChange);
    dom.lossMult.addEventListener("input", handleControlChange);
    dom.lossMultSequenceFields.addEventListener("input", handleLossMultSequenceInput);
    dom.lossMultSequenceFields.addEventListener("change", handleLossMultSequenceCommit);
    dom.kellyStartDeposit.addEventListener("input", handleKellyDepositInput);
    dom.kellyStartDeposit.addEventListener("change", handleKellyDepositCommit);
    dom.kellyPositionPct.addEventListener("input", handleKellyPositionChange);
    dom.fileInput.addEventListener("change", handleFileSelect);
    dom.autoBestButton.addEventListener("click", handleAutoBestClick);
    dom.manualBreakApplyButton.addEventListener("click", handleManualBreakApplyClick);
    dom.manualBreakUndoButton.addEventListener("click", handleManualBreakUndoClick);

    if (!String(dom.maxDrawdownCap.value || "").trim()) {
      dom.maxDrawdownCap.value = formatFixed(DEFAULT_MAX_DRAWDOWN_CAP, 0);
    }
    if (!String(dom.kellyStartDeposit.value || "").trim()) {
      dom.kellyStartDeposit.value = formatTrimmedNumber(DEFAULT_KELLY_START_DEPOSIT, 2);
    }
    if (!String(dom.kellyPositionPct.value || "").trim()) {
      dom.kellyPositionPct.value = formatFixed(DEFAULT_KELLY_POSITION_PCT, 1);
    }

    syncControlLabels();
    renderLossMultSequenceFields();
    renderState();
    setBusy(false);
    loadVisitCounter();

    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(function () {
        scheduleChartDraw();
      });
      observer.observe(dom.chartSurface);
    } else {
      window.addEventListener("resize", scheduleChartDraw);
    }

    if (new URLSearchParams(window.location.search).get("self-test") === "1") {
      runClientSelfTests();
    }
  }

  function emptySequenceSummary() {
    return {
      tradeCount: 0,
      winCount: 0,
      lossCount: 0,
      maxLossStreak: 0,
    };
  }

  function normalizeResetAfterLosses(value) {
    const numeric = Number(value);
    const normalized = Math.round(Number.isFinite(numeric) ? numeric : DEFAULT_RESET_AFTER_LOSSES);
    return Math.min(RESET_AFTER_LOSSES_MAX, Math.max(RESET_AFTER_LOSSES_MIN, normalized));
  }

  function normalizeLossMult(value) {
    const numeric = Number(value);
    const bounded = Math.min(LOSS_MULT_MAX, Math.max(LOSS_MULT_MIN, Number.isFinite(numeric) ? numeric : DEFAULT_LOSS_MULT));
    return Number((Math.round((bounded + EPSILON) * 10) / 10).toFixed(1));
  }

  function buildLossMultCandidates() {
    const steps = Math.round((LOSS_MULT_MAX - LOSS_MULT_MIN) / LOSS_MULT_STEP);
    const values = [];
    for (let index = 0; index <= steps; index += 1) {
      values.push(Number((LOSS_MULT_MIN + LOSS_MULT_STEP * index).toFixed(1)));
    }
    return values;
  }

  function buildLossMultSequence(resetAfterLosses, lossMult) {
    const normalizedReset = normalizeResetAfterLosses(resetAfterLosses);
    const normalizedLossMult = normalizeLossMult(lossMult);
    const values = [];
    for (let index = 0; index < normalizedReset; index += 1) {
      values.push(Number(Math.pow(normalizedLossMult, index).toFixed(6)));
    }
    return values;
  }

  function normalizeStepMultiplierValue(value, fallbackValue) {
    if (typeof value === "string" && !value.trim()) {
      return 1.0;
    }
    const parsed = parseNumericCell(value);
    if (parsed === null || parsed <= 0) {
      return Number((fallbackValue || 1.0).toFixed(6));
    }
    return Number(parsed.toFixed(6));
  }

  function normalizeLossMultSequence(values, resetAfterLosses, lossMult) {
    const normalizedReset = normalizeResetAfterLosses(resetAfterLosses);
    const defaults = buildLossMultSequence(normalizedReset, lossMult);
    const nextValues = [];

    for (let index = 0; index < normalizedReset; index += 1) {
      nextValues.push(
        normalizeStepMultiplierValue(
          Array.isArray(values) ? values[index] : null,
          defaults[index]
        )
      );
    }

    return nextValues;
  }

  function resizeLossMultSequence(values, resetAfterLosses, lossMult) {
    return normalizeLossMultSequence(values, resetAfterLosses, lossMult);
  }

  function formatStepMultiplier(value) {
    const numeric = normalizeStepMultiplierValue(value, 1.0);
    return formatFixed(numeric, 2).replace(".", ",");
  }

  function buildConfig(resetAfterLosses, lossMult) {
    return {
      baseStake: DEFAULT_BASE_STAKE,
      payoutPct: DEFAULT_PAYOUT_PCT,
      resetAfterLosses: normalizeResetAfterLosses(resetAfterLosses),
      lossMult: normalizeLossMult(lossMult),
      lossMultSequence: buildLossMultSequence(
        normalizeResetAfterLosses(resetAfterLosses),
        normalizeLossMult(lossMult)
      ),
    };
  }

  function normalizeKellyStartDeposit(value) {
    const parsed = parseNumericCell(value);
    const numeric = parsed === null ? DEFAULT_KELLY_START_DEPOSIT : parsed;
    return Number(Math.max(KELLY_START_DEPOSIT_MIN, numeric).toFixed(2));
  }

  function normalizeKellyPositionPct(value) {
    const numeric = Number(value);
    const bounded = Math.min(
      KELLY_POSITION_PCT_MAX,
      Math.max(
        KELLY_POSITION_PCT_MIN,
        Number.isFinite(numeric) ? numeric : DEFAULT_KELLY_POSITION_PCT
      )
    );
    return Number((Math.round((bounded + EPSILON) * 10) / 10).toFixed(1));
  }

  function buildKellyConfig(startDeposit, positionPct) {
    return {
      startDeposit: normalizeKellyStartDeposit(startDeposit),
      positionPct: normalizeKellyPositionPct(positionPct),
      payoutPct: DEFAULT_PAYOUT_PCT,
    };
  }

  function handleControlChange() {
    const nextReset = normalizeResetAfterLosses(dom.resetAfterLosses.value);
    const nextLossMult = normalizeLossMult(dom.lossMult.value);
    const resetChanged = nextReset !== state.config.resetAfterLosses;
    const lossMultChanged = nextLossMult !== state.config.lossMult;
    const nextConfig = buildConfig(nextReset, nextLossMult);

    if (lossMultChanged) {
      nextConfig.lossMultSequence = buildLossMultSequence(nextReset, nextLossMult);
    } else if (resetChanged) {
      nextConfig.lossMultSequence = resizeLossMultSequence(
        state.config.lossMultSequence,
        nextReset,
        nextLossMult
      );
    } else {
      nextConfig.lossMultSequence = normalizeLossMultSequence(
        state.config.lossMultSequence,
        nextReset,
        nextLossMult
      );
    }

    state.config = nextConfig;
    syncControlLabels();
    renderLossMultSequenceFields();
    if (!state.sequence.length) {
      renderState();
      return;
    }
    recomputePayload();
    renderState();
  }

  function handleKellyDepositInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    const parsed = parseNumericCell(target.value);
    if (parsed === null || parsed < KELLY_START_DEPOSIT_MIN) {
      return;
    }

    state.kellyConfig = buildKellyConfig(parsed, state.kellyConfig.positionPct);
    if (!state.sequence.length) {
      return;
    }

    recomputePayload();
    renderState();
  }

  function handleKellyDepositCommit(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    state.kellyConfig = buildKellyConfig(target.value, state.kellyConfig.positionPct);
    target.value = formatTrimmedNumber(state.kellyConfig.startDeposit, 2);

    if (!state.sequence.length) {
      return;
    }

    recomputePayload();
    renderState();
  }

  function handleKellyPositionChange() {
    state.kellyConfig = buildKellyConfig(
      state.kellyConfig.startDeposit,
      dom.kellyPositionPct.value
    );
    syncControlLabels();

    if (!state.sequence.length) {
      return;
    }

    recomputePayload();
    renderState();
  }

  async function handleFileSelect(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }

    setBusy(true);
    resetManualBreaks();
    recomputePayload();
    renderState();
    setStatus("Читаю `.xlsx` и строю последовательность сделок...", "neutral");

    try {
      const workbookData = await loadWorkbookFromFile(file);
      const sourceData = extractSequenceSource(workbookData, file.name);
      state.source = sourceData.source;
      state.sequence = sourceData.sequence;
      state.sequenceSummary = summarizeSequence(sourceData.sequence);
      state.actualCurve = buildCumulativeEquityCurveFromProfits(sourceData.actualProfits);
      state.actualFitEquityValues = buildCumulativeEquityCurveFromProfits(sourceData.fitProfits).equityValues;
      resetManualBreaks();
      setStatus("Файл загружен. Подбираю конфиг, близкий к реальному equity...", "neutral");
      await nextFrame();
      const closest = await findClosestCurveConfigAsync(
        state.sequence,
        state.sequenceSummary,
        state.actualFitEquityValues
      );
      state.config = closest.config;
      resetManualBreaks();
      recomputePayload();
      syncControlsFromState();
      renderState();
      setStatus(
        "Загружен `" + file.name + "`: " + state.sequenceSummary.tradeCount + " сделок. Ползунки приближены к реальному equity.",
        "success"
      );
    } catch (error) {
      resetSequenceState();
      renderState();
      setStatus(error instanceof Error ? error.message : "Не удалось обработать файл.", "error");
    } finally {
      setBusy(false);
      dom.fileInput.value = "";
    }
  }

  async function loadWorkbookFromFile(file) {
    const buffer = await file.arrayBuffer();
    const workbook = window.XLSX.read(buffer, {
      type: "array",
      cellDates: true,
    });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      throw new Error("В книге не найден ни один лист.");
    }
    const worksheet = workbook.Sheets[firstSheetName];
    const rows = window.XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });
    return {
      sheetName: firstSheetName,
      rows: Array.isArray(rows) ? rows : [],
    };
  }

  function extractSequenceSource(workbookData, fileName) {
    const rows = workbookData.rows;
    const records = [];
    for (let index = 1; index < rows.length; index += 1) {
      const row = Array.isArray(rows[index]) ? rows[index] : [];
      records.push([row[4], row[8], row[9]]);
    }

    const extracted = extractHistorySeriesFromRecords(records);
    return {
      sequence: extracted.sequence,
      actualProfits: extracted.actualProfits,
      fitProfits: extracted.fitProfits,
      source: {
        fileName: fileName,
        sheetName: workbookData.sheetName,
        rowCount: Math.max(0, rows.length - 1),
        tradeCount: extracted.sequence.length,
      },
    };
  }

  function resetSequenceState() {
    state.source = {
      fileName: "Файл не загружен",
      sheetName: "-",
      rowCount: 0,
      tradeCount: 0,
    };
    state.sequence = [];
    state.sequenceSummary = emptySequenceSummary();
    state.actualCurve = null;
    state.actualFitEquityValues = null;
    state.effectiveSequence = [];
    state.manualBreakIndices = [];
    state.manualBreakCandidateIndices = [];
    state.baselinePayload = null;
    state.payload = null;
    state.kellyPayload = null;
  }

  function resetManualBreaks() {
    state.manualBreakIndices = [];
    state.effectiveSequence = Array.isArray(state.sequence) ? state.sequence.slice() : [];
    state.manualBreakCandidateIndices = collectEligibleBreakCandidateIndices(
      state.effectiveSequence,
      state.config.resetAfterLosses
    );
  }

  function buildEffectiveSequence(values, manualBreakIndices) {
    const nextValues = Array.isArray(values) ? values.slice() : [];
    for (let index = 0; index < manualBreakIndices.length; index += 1) {
      const targetIndex = manualBreakIndices[index];
      if (targetIndex >= 0 && targetIndex < nextValues.length) {
        nextValues[targetIndex] = -1;
      }
    }
    return nextValues;
  }

  function collectEligibleBreakCandidateIndices(values, resetAfterLosses) {
    const candidates = [];
    const targetLosses = normalizeResetAfterLosses(resetAfterLosses) - 1;
    let lossStreak = 0;

    for (let index = 0; index < values.length; index += 1) {
      const outcome = values[index];
      if (outcome < 0) {
        lossStreak += 1;
        continue;
      }
      if (outcome > 0 && lossStreak === targetLosses) {
        candidates.push(index);
      }
      lossStreak = 0;
    }

    return candidates;
  }

  function pickRandomItem(values, randomFn) {
    if (!Array.isArray(values) || !values.length) {
      return null;
    }

    const randomValue = typeof randomFn === "function" ? randomFn() : Math.random();
    const normalized = Number.isFinite(randomValue) ? randomValue : Math.random();
    const rawIndex = Math.floor(normalized * values.length);
    const clampedIndex = Math.min(values.length - 1, Math.max(0, rawIndex));
    return values[clampedIndex];
  }

  function parseNumericCell(value) {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string") {
      const cleaned = value.trim().replace(/\s+/g, "").replace(",", ".");
      if (!cleaned) {
        return null;
      }
      const numeric = Number(cleaned);
      return Number.isFinite(numeric) ? numeric : null;
    }
    return null;
  }

  function parseHistoryRowResult(stakeValue, profitValue) {
    if (profitValue === null || profitValue === undefined) {
      return null;
    }
    const profit = parseNumericCell(profitValue);
    if (profit === null) {
      return null;
    }
    const stake = parseNumericCell(stakeValue);
    if (profit > 0 && stake !== null && !isNearlyEqual(profit, stake)) {
      return 1;
    }
    if (profit < 0) {
      return -1;
    }
    return null;
  }

  function normalizeDatetimeSortKey(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return { rank: 0, value: value.getTime() };
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const dateCode = window.XLSX && window.XLSX.SSF && window.XLSX.SSF.parse_date_code
        ? window.XLSX.SSF.parse_date_code(value)
        : null;
      if (dateCode && dateCode.y && dateCode.m && dateCode.d) {
        const timestamp = new Date(
          dateCode.y,
          dateCode.m - 1,
          dateCode.d,
          dateCode.H || 0,
          dateCode.M || 0,
          Math.floor(dateCode.S || 0)
        ).getTime();
        return { rank: 0, value: timestamp };
      }
      return { rank: 1, value: String(value) };
    }
    if (value === null || value === undefined) {
      return { rank: 2, value: "" };
    }
    const text = String(value).trim();
    if (!text) {
      return { rank: 2, value: "" };
    }
    const timestamp = Date.parse(text);
    if (!Number.isNaN(timestamp)) {
      return { rank: 0, value: timestamp };
    }
    return { rank: 1, value: text };
  }

  function compareSortKeys(left, right) {
    if (left.rank !== right.rank) {
      return left.rank - right.rank;
    }
    if (left.value < right.value) {
      return -1;
    }
    if (left.value > right.value) {
      return 1;
    }
    return 0;
  }

  function buildSequenceFromHistoryRecords(records) {
    return extractHistorySeriesFromRecords(records).sequence;
  }

  function buildSortedHistoryRecords(records) {
    return records.slice().sort(function (left, right) {
      return compareSortKeys(normalizeDatetimeSortKey(left[0]), normalizeDatetimeSortKey(right[0]));
    });
  }

  function extractHistorySeriesFromRecords(records) {
    const sortedRecords = buildSortedHistoryRecords(records);

    const values = [];
    const actualProfits = [];
    const fitProfits = [];
    for (let index = 0; index < sortedRecords.length; index += 1) {
      const record = sortedRecords[index];
      const profit = parseNumericCell(record[2]);
      if (profit !== null) {
        actualProfits.push(profit);
      }
      const result = parseHistoryRowResult(record[1], record[2]);
      if (result !== null) {
        values.push(result);
        if (profit !== null) {
          fitProfits.push(profit);
        }
      }
    }

    if (!values.length) {
      throw new Error("В файле не найдено ни одной подходящей сделки.");
    }
    return {
      sequence: values,
      actualProfits: actualProfits,
      fitProfits: fitProfits,
    };
  }

  function summarizeSequence(values) {
    let winCount = 0;
    let lossCount = 0;
    let maxLossStreak = 0;
    let currentLossStreak = 0;

    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value > 0) {
        winCount += 1;
        currentLossStreak = 0;
      } else if (value < 0) {
        lossCount += 1;
        currentLossStreak += 1;
        if (currentLossStreak > maxLossStreak) {
          maxLossStreak = currentLossStreak;
        }
      }
    }

    return {
      tradeCount: values.length,
      winCount: winCount,
      lossCount: lossCount,
      maxLossStreak: maxLossStreak,
    };
  }

  function simulateRuntimeGroupTrace(values, config) {
    const payoutFraction = config.payoutPct / 100.0;
    const stepMultipliers = normalizeLossMultSequence(
      config.lossMultSequence,
      config.resetAfterLosses,
      config.lossMult
    );
    const trace = [];
    let equity = 0.0;
    let lossStreak = 0;

    for (let index = 0; index < values.length; index += 1) {
      const outcome = values[index];
      const stepIndex = Math.min(lossStreak, stepMultipliers.length - 1);
      const stake = config.baseStake * stepMultipliers[stepIndex];

      trace.push({
        index: index + 1,
        stake: stake,
        outcome: outcome,
        equityBefore: equity,
        equity: null,
      });

      if (outcome > 0) {
        equity += stake * payoutFraction;
        lossStreak = 0;
      } else {
        equity -= stake;
        lossStreak += 1;
        if (lossStreak >= config.resetAfterLosses) {
          lossStreak = 0;
        }
      }

      trace[trace.length - 1].equity = equity;
    }

    return trace;
  }

  function summarizeRuntimeGroupTrace(trace) {
    let finalPnlNormalized = 0.0;
    let peakEquity = 0.0;
    let maxDrawdownNormalized = 0.0;
    let peakStakeNormalized = 0.0;

    for (let index = 0; index < trace.length; index += 1) {
      const point = trace[index];
      finalPnlNormalized = point.equity;
      if (point.stake > peakStakeNormalized) {
        peakStakeNormalized = point.stake;
      }
      if (point.equity > peakEquity) {
        peakEquity = point.equity;
      }
      const drawdown = peakEquity - point.equity;
      if (drawdown > maxDrawdownNormalized) {
        maxDrawdownNormalized = drawdown;
      }
    }

    return {
      finalPnlNormalized: finalPnlNormalized,
      maxDrawdownNormalized: maxDrawdownNormalized,
      peakStakeNormalized: peakStakeNormalized,
      recoveryFactor: computeProfitDrawdownRatio(finalPnlNormalized, maxDrawdownNormalized),
    };
  }

  function computeProfitDrawdownRatio(finalProfit, maxDrawdown) {
    if (maxDrawdown <= 0) {
      if (finalProfit > 0) {
        return Number.POSITIVE_INFINITY;
      }
      if (finalProfit < 0) {
        return Number.NEGATIVE_INFINITY;
      }
      return 0.0;
    }
    return finalProfit / maxDrawdown;
  }

  function buildPlotPayload(values, config, sequenceSummary) {
    const trace = simulateRuntimeGroupTrace(values, config);
    const metrics = summarizeRuntimeGroupTrace(trace);
    const tradeIndices = [0];
    const equityValues = [0.0];

    for (let index = 0; index < trace.length; index += 1) {
      tradeIndices.push(trace[index].index);
      equityValues.push(trace[index].equity);
    }

    return {
      tradeIndices: tradeIndices,
      equityValues: equityValues,
      metrics: metrics,
      sequenceSummary: sequenceSummary,
    };
  }

  function simulateKellyTrace(values, kellyConfig) {
    const payoutFraction = kellyConfig.payoutPct / 100.0;
    const trace = [];
    let balance = kellyConfig.startDeposit;

    for (let index = 0; index < values.length; index += 1) {
      const outcome = values[index];
      const rawStake = balance * (kellyConfig.positionPct / 100.0);
      const stake = balance + EPSILON >= KELLY_MIN_STAKE
        ? Math.min(balance, Math.max(KELLY_MIN_STAKE, rawStake))
        : 0.0;

      trace.push({
        index: index + 1,
        stake: stake,
        outcome: outcome,
        balanceBefore: balance,
        balance: null,
        equity: null,
      });

      if (outcome > 0) {
        balance += stake * payoutFraction;
      } else {
        balance -= stake;
      }

      if (balance < 0) {
        balance = 0.0;
      }

      trace[trace.length - 1].balance = balance;
      trace[trace.length - 1].equity = balance - kellyConfig.startDeposit;
    }

    return trace;
  }

  function summarizeKellyTrace(trace, kellyConfig) {
    let finalBalance = kellyConfig.startDeposit;
    let peakBalance = kellyConfig.startDeposit;
    let maxDrawdownNormalized = 0.0;
    let peakStakeNormalized = 0.0;

    for (let index = 0; index < trace.length; index += 1) {
      const point = trace[index];
      finalBalance = point.balance;
      if (point.stake > peakStakeNormalized) {
        peakStakeNormalized = point.stake;
      }
      if (point.balance > peakBalance) {
        peakBalance = point.balance;
      }
      const drawdown = peakBalance - point.balance;
      if (drawdown > maxDrawdownNormalized) {
        maxDrawdownNormalized = drawdown;
      }
    }

    const finalPnlNormalized = finalBalance - kellyConfig.startDeposit;
    return {
      finalPnlNormalized: finalPnlNormalized,
      maxDrawdownNormalized: maxDrawdownNormalized,
      peakStakeNormalized: peakStakeNormalized,
      recoveryFactor: computeProfitDrawdownRatio(finalPnlNormalized, maxDrawdownNormalized),
      finalBalance: finalBalance,
      startBalance: kellyConfig.startDeposit,
    };
  }

  function buildKellyPayload(values, kellyConfig, sequenceSummary) {
    const trace = simulateKellyTrace(values, kellyConfig);
    const metrics = summarizeKellyTrace(trace, kellyConfig);
    const tradeIndices = [0];
    const equityValues = [0.0];
    const balanceValues = [kellyConfig.startDeposit];

    for (let index = 0; index < trace.length; index += 1) {
      tradeIndices.push(trace[index].index);
      equityValues.push(trace[index].equity);
      balanceValues.push(trace[index].balance);
    }

    return {
      tradeIndices: tradeIndices,
      equityValues: equityValues,
      balanceValues: balanceValues,
      metrics: metrics,
      sequenceSummary: sequenceSummary,
    };
  }

  function buildCumulativeEquityCurveFromProfits(profits) {
    const tradeIndices = [0];
    const equityValues = [0.0];
    let equity = 0.0;

    for (let index = 0; index < profits.length; index += 1) {
      equity += profits[index];
      tradeIndices.push(index + 1);
      equityValues.push(equity);
    }

    return {
      tradeIndices: tradeIndices,
      equityValues: equityValues,
    };
  }

  async function findBestProfitDrawdownConfigAsync(values, sequenceSummary, maxDrawdownLimit, options) {
    const resetValues = options && Array.isArray(options.resetCandidates)
      ? options.resetCandidates.slice()
      : (function () {
          const values = [];
          for (let reset = RESET_AFTER_LOSSES_MIN; reset <= RESET_AFTER_LOSSES_MAX; reset += 1) {
            values.push(reset);
          }
          return values;
        })();
    const multValues = options && Array.isArray(options.multCandidates)
      ? options.multCandidates.slice()
      : buildLossMultCandidates();
    const yieldEvery = options && typeof options.yieldEvery === "number" ? options.yieldEvery : 45;

    let bestConfig = null;
    let bestPayload = null;
    let bestRank = null;
    let processed = 0;
    const total = resetValues.length * multValues.length;

    for (let resetIndex = 0; resetIndex < resetValues.length; resetIndex += 1) {
      for (let multIndex = 0; multIndex < multValues.length; multIndex += 1) {
        const config = buildConfig(resetValues[resetIndex], multValues[multIndex]);
        const payload = buildPlotPayload(values, config, sequenceSummary);

        if (
          maxDrawdownLimit !== null &&
          payload.metrics.maxDrawdownNormalized > maxDrawdownLimit + EPSILON
        ) {
          processed += 1;
          if (yieldEvery > 0 && processed % yieldEvery === 0) {
            setStatus("Идет автоподбор: " + processed + " / " + total + " конфигов...", "neutral");
            await nextFrame();
          }
          continue;
        }

        const rank = [
          computeProfitDrawdownRatio(
            payload.metrics.finalPnlNormalized,
            payload.metrics.maxDrawdownNormalized
          ),
          payload.metrics.finalPnlNormalized,
          -payload.metrics.maxDrawdownNormalized,
          -payload.metrics.peakStakeNormalized,
          -config.lossMult,
          -config.resetAfterLosses,
        ];

        if (bestRank === null || compareRanks(rank, bestRank) > 0) {
          bestConfig = config;
          bestPayload = payload;
          bestRank = rank;
        }

        processed += 1;
        if (yieldEvery > 0 && processed % yieldEvery === 0) {
          setStatus("Идет автоподбор: " + processed + " / " + total + " конфигов...", "neutral");
          await nextFrame();
        }
      }
    }

    if (!bestConfig || !bestPayload) {
      if (maxDrawdownLimit === null) {
        throw new Error("Не удалось получить ни одного кандидата для автоподбора.");
      }
      throw new Error("Нет конфигурации, которая укладывается в Max DD <= " + formatFixed(maxDrawdownLimit, 2));
    }

    return {
      config: bestConfig,
      payload: bestPayload,
    };
  }

  async function findClosestCurveConfigAsync(values, sequenceSummary, targetEquityValues, options) {
    if (!Array.isArray(targetEquityValues) || targetEquityValues.length <= 1) {
      throw new Error("Недостаточно данных для подбора конфигурации по реальному equity.");
    }

    const resetValues = options && Array.isArray(options.resetCandidates)
      ? options.resetCandidates.slice()
      : (function () {
          const values = [];
          for (let reset = RESET_AFTER_LOSSES_MIN; reset <= RESET_AFTER_LOSSES_MAX; reset += 1) {
            values.push(reset);
          }
          return values;
        })();
    const multValues = options && Array.isArray(options.multCandidates)
      ? options.multCandidates.slice()
      : buildLossMultCandidates();
    const yieldEvery = options && typeof options.yieldEvery === "number" ? options.yieldEvery : 45;
    const targetMetrics = summarizeEquityValues(targetEquityValues);

    let bestConfig = null;
    let bestPayload = null;
    let bestRank = null;
    let processed = 0;
    const total = resetValues.length * multValues.length;

    for (let resetIndex = 0; resetIndex < resetValues.length; resetIndex += 1) {
      for (let multIndex = 0; multIndex < multValues.length; multIndex += 1) {
        const config = buildConfig(resetValues[resetIndex], multValues[multIndex]);
        const payload = buildPlotPayload(values, config, sequenceSummary);
        const fitRank = buildCurveFitRank(payload.equityValues, targetEquityValues, targetMetrics, payload.metrics);

        if (bestRank === null || compareAscendingRanks(fitRank, bestRank) < 0) {
          bestConfig = config;
          bestPayload = payload;
          bestRank = fitRank;
        }

        processed += 1;
        if (yieldEvery > 0 && processed % yieldEvery === 0) {
          setStatus("Подбираю конфиг по похожести: " + processed + " / " + total + "...", "neutral");
          await nextFrame();
        }
      }
    }

    if (!bestConfig || !bestPayload) {
      throw new Error("Не удалось подобрать конфигурацию, похожую на реальный equity.");
    }

    return {
      config: bestConfig,
      payload: bestPayload,
    };
  }

  function compareRanks(left, right) {
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] > right[index]) {
        return 1;
      }
      if (left[index] < right[index]) {
        return -1;
      }
    }
    return 0;
  }

  function compareAscendingRanks(left, right) {
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] < right[index]) {
        return -1;
      }
      if (left[index] > right[index]) {
        return 1;
      }
    }
    return 0;
  }

  function buildCurveFitRank(simulatedEquityValues, targetEquityValues, targetMetrics, simulatedMetrics) {
    const count = Math.min(simulatedEquityValues.length, targetEquityValues.length);
    let squaredError = 0.0;
    let absoluteError = 0.0;
    let maxAbsoluteError = 0.0;

    for (let index = 0; index < count; index += 1) {
      const diff = simulatedEquityValues[index] - targetEquityValues[index];
      const absDiff = Math.abs(diff);
      squaredError += diff * diff;
      absoluteError += absDiff;
      if (absDiff > maxAbsoluteError) {
        maxAbsoluteError = absDiff;
      }
    }

    const mse = squaredError / count;
    const mae = absoluteError / count;
    const finalDiff = Math.abs(
      simulatedEquityValues[simulatedEquityValues.length - 1] -
      targetEquityValues[targetEquityValues.length - 1]
    );

    return [
      mse,
      mae,
      maxAbsoluteError,
      finalDiff,
      Math.abs(simulatedMetrics.maxDrawdownNormalized - targetMetrics.maxDrawdown),
      Math.abs(simulatedMetrics.finalPnlNormalized - targetMetrics.finalPnl),
    ];
  }

  function summarizeEquityValues(equityValues) {
    let peak = equityValues[0] || 0.0;
    let maxDrawdown = 0.0;

    for (let index = 0; index < equityValues.length; index += 1) {
      const value = equityValues[index];
      if (value > peak) {
        peak = value;
      }
      const drawdown = peak - value;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return {
      finalPnl: equityValues[equityValues.length - 1] || 0.0,
      maxDrawdown: maxDrawdown,
    };
  }

  async function handleAutoBestClick() {
    if (!state.sequence.length || state.busy) {
      return;
    }

    setBusy(true);
    resetManualBreaks();
    recomputePayload();
    renderState();

    try {
      const maxDrawdownLimit = parseMaxDrawdownLimit(dom.maxDrawdownCap.value);
      setStatus("Подготавливаю автопоиск лучшего P/DD...", "neutral");
      await nextFrame();
      const best = await findBestProfitDrawdownConfigAsync(
        state.sequence,
        state.sequenceSummary,
        maxDrawdownLimit
      );
      state.config = best.config;
      resetManualBreaks();
      recomputePayload();
      syncControlsFromState();
      renderState();
      if (maxDrawdownLimit === null) {
        setStatus("Автоподбор завершен без ограничения по Max DD.", "success");
      } else {
        setStatus(
          "Автоподбор завершен. Max DD <= " + formatFixed(maxDrawdownLimit, 2) + ".",
          "success"
        );
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Автоподбор завершился с ошибкой.", "error");
    } finally {
      setBusy(false);
    }
  }

  function handleManualBreakApplyClick() {
    if (state.busy || !state.sequence.length) {
      return;
    }

    const targetIndex = pickRandomItem(state.manualBreakCandidateIndices);
    if (targetIndex === null) {
      setStatus("Подходящие завершающие плюсы закончились.", "neutral");
      renderState();
      return;
    }

    state.manualBreakIndices.push(targetIndex);
    recomputePayload();
    renderState();

    if (state.manualBreakCandidateIndices.length) {
      setStatus("Сделка #" + String(targetIndex + 1) + " переведена в минус для сценарного теста.", "success");
      return;
    }

    setStatus("Сделка #" + String(targetIndex + 1) + " переведена в минус. Больше кандидатов нет.", "success");
  }

  function handleManualBreakUndoClick() {
    if (state.busy || !state.manualBreakIndices.length) {
      return;
    }

    const restoredIndex = state.manualBreakIndices.pop();
    recomputePayload();
    renderState();
    setStatus("Сделка #" + String(restoredIndex + 1) + " возвращена назад.", "success");
  }

  function parseMaxDrawdownLimit(text) {
    const cleaned = String(text || "").trim();
    if (!cleaned) {
      return null;
    }
    const normalized = cleaned.replace(",", ".");
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric)) {
      throw new Error("Max DD cap должен быть числом.");
    }
    if (numeric < 0) {
      throw new Error("Max DD cap должен быть >= 0.");
    }
    return Number((numeric + EPSILON).toFixed(2));
  }

  function recomputePayload() {
    if (!state.sequence.length) {
      state.effectiveSequence = [];
      state.manualBreakCandidateIndices = [];
      state.baselinePayload = null;
      state.payload = null;
      state.kellyPayload = null;
      return;
    }

    state.effectiveSequence = buildEffectiveSequence(state.sequence, state.manualBreakIndices);
    state.manualBreakCandidateIndices = collectEligibleBreakCandidateIndices(
      state.effectiveSequence,
      state.config.resetAfterLosses
    );
    state.baselinePayload = buildPlotPayload(
      state.sequence,
      state.config,
      summarizeSequence(state.sequence)
    );
    state.payload = buildPlotPayload(
      state.effectiveSequence,
      state.config,
      summarizeSequence(state.effectiveSequence)
    );
    state.kellyPayload = buildKellyPayload(
      state.effectiveSequence,
      state.kellyConfig,
      summarizeSequence(state.effectiveSequence)
    );
  }

  function syncControlsFromState() {
    dom.resetAfterLosses.value = String(state.config.resetAfterLosses);
    dom.lossMult.value = String(state.config.lossMult);
    dom.kellyStartDeposit.value = formatTrimmedNumber(state.kellyConfig.startDeposit, 2);
    dom.kellyPositionPct.value = String(state.kellyConfig.positionPct);
    syncControlLabels();
    renderLossMultSequenceFields();
  }

  function syncControlLabels() {
    dom.resetAfterLossesValue.textContent = String(normalizeResetAfterLosses(dom.resetAfterLosses.value));
    dom.lossMultValue.textContent = formatFixed(normalizeLossMult(dom.lossMult.value), 1) + "x";
    dom.kellyPositionPctValue.textContent = formatFixed(normalizeKellyPositionPct(dom.kellyPositionPct.value), 1) + "%";
  }

  function renderLossMultSequenceFields() {
    const sequence = normalizeLossMultSequence(
      state.config.lossMultSequence,
      state.config.resetAfterLosses,
      state.config.lossMult
    );

    dom.lossMultSequenceFields.innerHTML = sequence.map(function (value, index) {
      const disabledAttr = state.busy ? " disabled" : "";
      return (
        '<label class="step-mult-item">' +
        '<span class="step-mult-label">Шаг ' + escapeHtml(String(index + 1)) + "</span>" +
        '<input class="step-mult-input" type="text" inputmode="decimal" data-step-index="' + escapeHtml(String(index)) + '" value="' + escapeHtml(formatStepMultiplier(value)) + '"' + disabledAttr + ">" +
        "</label>"
      );
    }).join("");
  }

  function handleLossMultSequenceInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.hasAttribute("data-step-index")) {
      return;
    }

    const index = Number(target.getAttribute("data-step-index"));
    if (!Number.isInteger(index) || index < 0) {
      return;
    }

    const nextSequence = state.config.lossMultSequence.slice();
    const fallbackValue = nextSequence[index];
    nextSequence[index] = normalizeStepMultiplierValue(target.value, fallbackValue);
    state.config.lossMultSequence = normalizeLossMultSequence(
      nextSequence,
      state.config.resetAfterLosses,
      state.config.lossMult
    );

    if (!state.sequence.length) {
      return;
    }

    recomputePayload();
    renderState();
  }

  function handleLossMultSequenceCommit(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.hasAttribute("data-step-index")) {
      return;
    }

    const index = Number(target.getAttribute("data-step-index"));
    if (!Number.isInteger(index) || index < 0) {
      return;
    }

    const committedValue = normalizeStepMultiplierValue(target.value, state.config.lossMultSequence[index]);
    state.config.lossMultSequence[index] = committedValue;
    target.value = formatStepMultiplier(committedValue);

    if (!state.sequence.length) {
      return;
    }

    recomputePayload();
    renderState();
  }

  function renderState() {
    renderSourceMeta();
    renderStats();
    renderChartMeta();
    renderManualBreakControls();
    scheduleChartDraw();
  }

  function renderManualBreakControls() {
    dom.manualBreakCount.textContent = String(state.manualBreakIndices.length);
    dom.manualBreakApplyButton.disabled =
      state.busy ||
      !state.sequence.length ||
      !state.manualBreakCandidateIndices.length;
    dom.manualBreakUndoButton.disabled =
      state.busy ||
      !state.manualBreakIndices.length;
  }

  function renderSourceMeta() {
    dom.sourceFileName.textContent = state.source.fileName;
    dom.sourceTradeCount.textContent = String(state.source.tradeCount);
    dom.sourceRowCount.textContent = String(state.source.rowCount);
  }

  function renderStats() {
    const rows = buildStatsRows();
    dom.statsGrid.innerHTML = rows.map(function (row) {
      const hintText = row.hint || getStatHint(row.label);
      const hint = hintText ? escapeHtml(hintText) : "";
      const hintAttrs = hint
        ? ' class="stats-label" tabindex="0" title="' + hint + '" data-tooltip="' + hint + '"'
        : ' class="stats-label"';
      return (
        '<div class="stats-item"><dt><span' +
        hintAttrs +
        ">" +
        escapeHtml(row.label) +
        "</span></dt><dd>" +
        escapeHtml(row.value) +
        "</dd></div>"
      );
    }).join("");
  }

  function getStatHint(label) {
    const normalized = String(label || "").trim();
    if (normalized === "Ratio") {
      return "Отношение итоговой прибыли к максимальной просадке. Чем выше значение, тем лучше результат относительно риска.";
    }
    if (normalized.indexOf("PnL") !== -1) {
      return "Финальный результат мартингейл-кривой после всех сделок в расчете.";
    }
    if (normalized === "Max drawdown") {
      return "Максимальная просадка от локального пика equity до следующего минимума.";
    }
    if (normalized === "Peak stake") {
      return "Самая большая ставка, до которой разгонялся мартингейл в расчете.";
    }
    if (normalized === "Winrate") {
      return "Доля плюсовых сделок от общего количества сделок.";
    }
    if (normalized === "Max loss streak") {
      return "Самая длинная непрерывная серия минусовых сделок.";
    }
    if (normalized === "\u0421\u0434\u0435\u043b\u043e\u043a") {
      return "Количество сделок, которые вошли в расчет последовательности.";
    }
    if (normalized === "\u041f\u043b\u044e\u0441\u043e\u0432\u044b\u0445") {
      return "Сколько сделок в последовательности закрылись в плюс.";
    }
    if (normalized === "\u041c\u0438\u043d\u0443\u0441\u043e\u0432\u044b\u0445") {
      return "Сколько сделок в последовательности закрылись в минус.";
    }
    return "";
  }

  function buildStatsRows() {
    if (!state.payload) {
      return [
        { label: "Ratio", value: "-" },
        { label: "Итоговый PnL", value: "-" },
        { label: "Max drawdown", value: "-" },
        { label: "Peak stake", value: "-" },
        { label: "Сделок", value: "0" },
        { label: "Плюсовых", value: "0" },
        { label: "Минусовых", value: "0" },
        { label: "Winrate", value: "0.00%" },
        { label: "Max loss streak", value: "0" },
      ];
    }

    const summary = state.payload.sequenceSummary;
    const metrics = state.payload.metrics;
    const winRate = summary.tradeCount > 0 ? (summary.winCount * 100.0) / summary.tradeCount : 0.0;

    return [
      { label: "Ratio", value: formatRatio(metrics.recoveryFactor) },
      { label: "Итоговый PnL", value: formatMoney(metrics.finalPnlNormalized) },
      { label: "Max drawdown", value: formatMoney(metrics.maxDrawdownNormalized) },
      { label: "Peak stake", value: formatMoney(metrics.peakStakeNormalized) },
      { label: "Сделок", value: String(summary.tradeCount) },
      { label: "Плюсовых", value: String(summary.winCount) },
      { label: "Минусовых", value: String(summary.lossCount) },
      { label: "Winrate", value: formatFixed(winRate, 2) + "%" },
      { label: "Max loss streak", value: String(summary.maxLossStreak) },
    ];
  }

  function renderChartMeta() {
    if (!state.payload) {
      dom.chartTitle.textContent = "График недоступен";
      dom.chartSummary.textContent = "Нет данных для расчета.";
      dom.chartEmptyState.hidden = false;
      return;
    }

    dom.chartTitle.textContent = state.source.fileName;
    dom.chartSummary.textContent =
      "reset " + state.config.resetAfterLosses +
      ", mult " + formatFixed(state.config.lossMult, 1) +
      "x, итог " + formatMoney(state.payload.metrics.finalPnlNormalized) + ".";
    dom.chartEmptyState.hidden = true;
  }

  function drawChart() {
    const canvas = dom.chartCanvas;
    const surface = dom.chartSurface;
    const rect = surface.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect.width));
    const height = Math.max(320, Math.floor(rect.height));
    const ratio = window.devicePixelRatio || 1;

    if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
    }

    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    drawChartBackground(context, width, height);

    if (!state.payload || !state.actualCurve) {
      return;
    }

    const margins = {
      top: 28,
      right: 20,
      bottom: 48,
      left: 60,
    };
    const plotWidth = width - margins.left - margins.right;
    const plotHeight = height - margins.top - margins.bottom;
    if (plotWidth <= 0 || plotHeight <= 0) {
      return;
    }

    const domain = calculateCombinedYDomain([
      state.actualCurve.equityValues,
      state.payload.equityValues,
      state.baselinePayload ? state.baselinePayload.equityValues : [],
    ]);
    const xMax = Math.max(
      1,
      state.actualCurve.tradeIndices[state.actualCurve.tradeIndices.length - 1] || 1,
      state.payload.tradeIndices[state.payload.tradeIndices.length - 1] || 1
    );

    const xScale = function (value) {
      return margins.left + (value / xMax) * plotWidth;
    };
    const yScale = function (value) {
      return margins.top + ((domain.max - value) / (domain.max - domain.min)) * plotHeight;
    };

    drawGrid(context, width, height, margins, domain, xMax, xScale, yScale);
    drawSeriesLine(
      context,
      state.actualCurve.tradeIndices,
      state.actualCurve.equityValues,
      xScale,
      yScale,
      {
        color: "#c04b37",
        width: 2.2,
        dash: [],
      }
    );
    drawSeriesLine(
      context,
      state.payload.tradeIndices,
      state.payload.equityValues,
      xScale,
      yScale,
      {
        color: "#0f6f63",
        width: 3.0,
        dash: [],
      }
    );
    drawFinalPoint(context, state.actualCurve.tradeIndices, state.actualCurve.equityValues, xScale, yScale, "#c04b37");
    drawFinalPoint(context, state.payload.tradeIndices, state.payload.equityValues, xScale, yScale, "#0f6f63");
    drawLegend(context, width, margins);
  }

  function drawChartBackground(context, width, height) {
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "rgba(255, 255, 255, 0.76)");
    gradient.addColorStop(1, "rgba(241, 231, 212, 0.42)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  }

  function calculateCombinedYDomain(seriesList) {
    let minValue = 0.0;
    let maxValue = 0.0;
    for (let seriesIndex = 0; seriesIndex < seriesList.length; seriesIndex += 1) {
      const values = seriesList[seriesIndex] || [];
      for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (value < minValue) {
          minValue = value;
        }
        if (value > maxValue) {
          maxValue = value;
        }
      }
    }

    if (isNearlyEqual(minValue, maxValue)) {
      const pad = Math.max(1.0, Math.abs(maxValue) * 0.15 || 1.0);
      return {
        min: minValue - pad,
        max: maxValue + pad,
      };
    }

    const range = maxValue - minValue;
    const padding = Math.max(1.0, range * 0.12);
    return {
      min: minValue - padding,
      max: maxValue + padding,
    };
  }

  function drawGrid(context, width, height, margins, domain, xMax, xScale, yScale) {
    const horizontalSteps = 5;
    const verticalSteps = Math.min(6, Math.max(3, xMax));

    context.save();
    context.strokeStyle = "rgba(101, 76, 44, 0.14)";
    context.fillStyle = "rgba(101, 76, 44, 0.72)";
    context.font = "12px Bahnschrift, Segoe UI";
    context.lineWidth = 1;

    for (let step = 0; step <= horizontalSteps; step += 1) {
      const value = domain.min + ((domain.max - domain.min) * step) / horizontalSteps;
      const y = margins.top + ((horizontalSteps - step) / horizontalSteps) * (height - margins.top - margins.bottom);

      context.beginPath();
      context.moveTo(margins.left, y);
      context.lineTo(width - margins.right, y);
      context.stroke();

      context.fillText(formatFixed(value, 2), 10, y + 4);
    }

    for (let step = 0; step <= verticalSteps; step += 1) {
      const tradeIndex = Math.round((xMax * step) / verticalSteps);
      const x = xScale(tradeIndex);
      context.beginPath();
      context.moveTo(x, margins.top);
      context.lineTo(x, height - margins.bottom);
      context.stroke();
      context.fillText(String(tradeIndex), x - 8, height - 16);
    }

    const zeroY = yScale(0);
    context.strokeStyle = "rgba(165, 60, 46, 0.38)";
    context.setLineDash([6, 5]);
    context.beginPath();
    context.moveTo(margins.left, zeroY);
    context.lineTo(width - margins.right, zeroY);
    context.stroke();

    context.setLineDash([]);
    context.fillStyle = "rgba(35, 24, 15, 0.84)";
    context.fillText("Trade index", width - margins.right - 66, height - 16);

    context.save();
    context.translate(16, margins.top + 24);
    context.rotate(-Math.PI / 2);
    context.fillText("Equity, USD", 0, 0);
    context.restore();

    context.restore();
  }

  function drawSeriesLine(context, tradeIndices, equityValues, xScale, yScale, options) {
    context.save();
    context.strokeStyle = options.color;
    context.lineWidth = options.width;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.setLineDash(options.dash || []);
    context.beginPath();
    for (let index = 0; index < tradeIndices.length; index += 1) {
      const x = xScale(tradeIndices[index]);
      const y = yScale(equityValues[index]);
      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }
    context.stroke();
    context.restore();
  }

  function drawFinalPoint(context, tradeIndices, equityValues, xScale, yScale, color) {
    const lastIndex = tradeIndices.length - 1;
    const x = xScale(tradeIndices[lastIndex]);
    const y = yScale(equityValues[lastIndex]);

    context.save();
    context.fillStyle = color;
    context.beginPath();
    context.arc(x, y, 5, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  function drawLegend(context, width, margins) {
    const startX = width - margins.right - 210;
    const startY = margins.top + 16;

    context.save();
    context.font = "12px Bahnschrift, Segoe UI";
    context.textBaseline = "middle";

    drawLegendItem(context, startX, startY, "#c04b37", [], "Реальное equity");
    drawLegendItem(context, startX, startY + 22, "#0f6f63", [], "Мартингейл");

    context.restore();
  }

  function drawLegendItem(context, x, y, color, dash, label) {
    context.save();
    context.strokeStyle = color;
    context.lineWidth = 3;
    context.setLineDash(dash);
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + 28, y);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = "rgba(35, 24, 15, 0.84)";
    context.fillText(label, x + 38, y);
    context.restore();
  }

  function buildStatsRows() {
    if (!state.payload || !state.kellyPayload) {
      return [
        { label: "Martingale Ratio", value: "-", hint: "Отношение итоговой прибыли мартингейла к его максимальной просадке." },
        { label: "Martingale PnL", value: "-", hint: "Итоговый результат мартингейл-кривой." },
        { label: "Martingale Max DD", value: "-", hint: "Максимальная просадка мартингейл-кривой." },
        { label: "Martingale Peak Stake", value: "-", hint: "Максимальная ставка, до которой доходил мартингейл." },
        { label: "Kelly Ratio", value: "-", hint: "Отношение итоговой прибыли Kelly-кривой к ее максимальной просадке." },
        { label: "Kelly PnL", value: "-", hint: "Итоговый результат Kelly-кривой относительно стартового депозита." },
        { label: "Kelly Max DD", value: "-", hint: "Максимальная просадка Kelly-кривой в долларах." },
        { label: "Kelly Peak Position", value: "-", hint: "Максимальный размер позиции в долларах при выбранном проценте от депозита." },
        { label: "Сделок", value: "0" },
        { label: "Плюсовых", value: "0" },
        { label: "Минусовых", value: "0" },
        { label: "Winrate", value: "0.00%" },
        { label: "Max loss streak", value: "0" },
      ];
    }

    const summary = state.payload.sequenceSummary;
    const martingaleMetrics = state.payload.metrics;
    const kellyMetrics = state.kellyPayload.metrics;
    const winRate = summary.tradeCount > 0 ? (summary.winCount * 100.0) / summary.tradeCount : 0.0;

    return [
      {
        label: "Martingale Ratio",
        value: formatRatio(martingaleMetrics.recoveryFactor),
        hint: "Отношение итоговой прибыли мартингейла к его максимальной просадке.",
      },
      {
        label: "Martingale PnL",
        value: formatMoney(martingaleMetrics.finalPnlNormalized),
        hint: "Итоговый результат мартингейл-кривой после всех сделок.",
      },
      {
        label: "Martingale Max DD",
        value: formatMoney(martingaleMetrics.maxDrawdownNormalized),
        hint: "Максимальная просадка мартингейл-кривой от локального пика.",
      },
      {
        label: "Martingale Peak Stake",
        value: formatMoney(martingaleMetrics.peakStakeNormalized),
        hint: "Самая большая ставка, до которой доходил мартингейл.",
      },
      {
        label: "Kelly Ratio",
        value: formatRatio(kellyMetrics.recoveryFactor),
        hint: "Отношение итоговой прибыли Kelly-кривой к ее максимальной просадке.",
      },
      {
        label: "Kelly PnL",
        value: formatMoney(kellyMetrics.finalPnlNormalized),
        hint: "Итоговый результат Kelly-кривой относительно стартового депозита.",
      },
      {
        label: "Kelly Max DD",
        value: formatMoney(kellyMetrics.maxDrawdownNormalized),
        hint: "Максимальная просадка Kelly-кривой в долларах.",
      },
      {
        label: "Kelly Peak Position",
        value: formatMoney(kellyMetrics.peakStakeNormalized),
        hint: "Максимальный размер позиции в долларах при выбранном проценте от депозита.",
      },
      { label: "Сделок", value: String(summary.tradeCount) },
      { label: "Плюсовых", value: String(summary.winCount) },
      { label: "Минусовых", value: String(summary.lossCount) },
      { label: "Winrate", value: formatFixed(winRate, 2) + "%" },
      { label: "Max loss streak", value: String(summary.maxLossStreak) },
    ];
  }

  function renderChartMeta() {
    if (!state.payload || !state.kellyPayload) {
      dom.chartTitle.textContent = "График недоступен";
      dom.chartSummary.innerHTML = '<span class="chart-summary-empty">Нет данных для расчета.</span>';
      dom.chartEmptyState.hidden = false;
      return;
    }

    dom.chartTitle.textContent = state.source.fileName;
    dom.chartSummary.innerHTML = [
      buildChartSummaryCard("mg", "MG", [
        "reset " + state.config.resetAfterLosses,
        "mult " + formatFixed(state.config.lossMult, 1) + "x",
        "PnL " + formatMoney(state.payload.metrics.finalPnlNormalized),
      ]),
      buildChartSummaryCard("kelly", "Kelly", [
        "депозит " + formatTrimmedNumber(state.kellyConfig.startDeposit, 2) + " USD",
        "позиция " + formatFixed(state.kellyConfig.positionPct, 1) + "%",
        "PnL " + formatMoney(state.kellyPayload.metrics.finalPnlNormalized),
      ]),
    ].join("");
    dom.chartEmptyState.hidden = true;
  }

  function buildChartSummaryCard(className, label, items) {
    return (
      '<span class="chart-summary-card ' + className + '">' +
      '<span class="chart-summary-label">' + escapeHtml(label) + "</span>" +
      items.map(function (item) {
        return '<span class="chart-summary-item">' + escapeHtml(item) + "</span>";
      }).join("") +
      "</span>"
    );
  }

  function drawChart() {
    const canvas = dom.chartCanvas;
    const surface = dom.chartSurface;
    const rect = surface.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect.width));
    const height = Math.max(320, Math.floor(rect.height));
    const ratio = window.devicePixelRatio || 1;

    if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
    }

    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    drawChartBackground(context, width, height);

    if (!state.payload || !state.actualCurve || !state.kellyPayload) {
      return;
    }

    const margins = {
      top: 28,
      right: 20,
      bottom: 48,
      left: 60,
    };
    const plotWidth = width - margins.left - margins.right;
    const plotHeight = height - margins.top - margins.bottom;
    if (plotWidth <= 0 || plotHeight <= 0) {
      return;
    }

    const domain = calculateCombinedYDomain([
      state.actualCurve.equityValues,
      state.payload.equityValues,
      state.baselinePayload ? state.baselinePayload.equityValues : [],
      state.kellyPayload.equityValues,
    ]);
    const xMax = Math.max(
      1,
      state.actualCurve.tradeIndices[state.actualCurve.tradeIndices.length - 1] || 1,
      state.payload.tradeIndices[state.payload.tradeIndices.length - 1] || 1,
      state.kellyPayload.tradeIndices[state.kellyPayload.tradeIndices.length - 1] || 1
    );

    const xScale = function (value) {
      return margins.left + (value / xMax) * plotWidth;
    };
    const yScale = function (value) {
      return margins.top + ((domain.max - value) / (domain.max - domain.min)) * plotHeight;
    };

    drawGrid(context, width, height, margins, domain, xMax, xScale, yScale);
    drawSeriesLine(
      context,
      state.actualCurve.tradeIndices,
      state.actualCurve.equityValues,
      xScale,
      yScale,
      {
        color: "#c04b37",
        width: 2.2,
        dash: [],
      }
    );
    drawSeriesLine(
      context,
      state.payload.tradeIndices,
      state.payload.equityValues,
      xScale,
      yScale,
      {
        color: "#0f6f63",
        width: 3.0,
        dash: [],
      }
    );
    drawSeriesLine(
      context,
      state.kellyPayload.tradeIndices,
      state.kellyPayload.equityValues,
      xScale,
      yScale,
      {
        color: "#295fb7",
        width: 2.6,
        dash: [10, 6],
      }
    );
    drawFinalPoint(context, state.actualCurve.tradeIndices, state.actualCurve.equityValues, xScale, yScale, "#c04b37");
    drawFinalPoint(context, state.payload.tradeIndices, state.payload.equityValues, xScale, yScale, "#0f6f63");
    drawFinalPoint(context, state.kellyPayload.tradeIndices, state.kellyPayload.equityValues, xScale, yScale, "#295fb7");
    drawLegend(context, width, margins);
  }

  function drawLegend(context, width, margins) {
    const items = [
      { color: "#c04b37", dash: [], label: "Реальное equity" },
      { color: "#0f6f63", dash: [], label: "Мартингейл" },
      { color: "#295fb7", dash: [10, 6], label: "Kelly" },
    ];
    const startX = width - margins.right - 220;
    const startY = margins.top + 16;

    context.save();
    context.font = "12px Bahnschrift, Segoe UI";
    context.textBaseline = "middle";

    for (let index = 0; index < items.length; index += 1) {
      drawLegendItem(
        context,
        startX,
        startY + index * 22,
        items[index].color,
        items[index].dash,
        items[index].label
      );
    }

    context.restore();
  }

  function setBusy(value) {
    state.busy = Boolean(value);
    dom.autoBestButton.disabled = state.busy || !state.sequence.length;
    dom.fileInput.disabled = state.busy;
    dom.resetAfterLosses.disabled = state.busy;
    dom.lossMult.disabled = state.busy;
    dom.kellyStartDeposit.disabled = state.busy;
    dom.kellyPositionPct.disabled = state.busy;
    renderLossMultSequenceFields();
    renderManualBreakControls();
  }

  function setStatus(message, tone) {
    dom.statusBanner.textContent = message;
    dom.statusBanner.className = "status-banner " + tone;
  }

  function formatMoney(value) {
    return formatFixed(value, 2) + " USD";
  }

  function formatTrimmedNumber(value, digits) {
    return formatFixed(value, digits).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
  }

  function formatFixed(value, digits) {
    return Number(value).toFixed(digits);
  }

  function formatRatio(value) {
    if (value === Number.POSITIVE_INFINITY) {
      return "inf";
    }
    if (value === Number.NEGATIVE_INFINITY) {
      return "-inf";
    }
    return formatFixed(value, 4);
  }

  function isNearlyEqual(left, right) {
    return Math.abs(left - right) <= EPSILON;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function nextFrame() {
    return new Promise(function (resolve) {
      window.requestAnimationFrame(function () {
        resolve();
      });
    });
  }

  async function loadVisitCounter() {
    if (!dom.visitCounterOverall || !dom.visitCounterToday || !dom.visitCounterNote) {
      return;
    }

    setVisitCounterState("—", "—", "Счетчик посетителей загружается...", false);

    try {
      const payload = await fetchVisitCounter();
      setVisitCounterState(
        formatCounterNumber(payload.overallUniqueVisitors),
        formatCounterNumber(payload.todayUniqueVisitors),
        "Уникальные посетители по cookie браузера.",
        false
      );
    } catch (error) {
      if (typeof console !== "undefined" && typeof console.error === "function") {
        console.error("Visit counter unavailable.", error);
      }
      setVisitCounterState("—", "—", "Счетчик посетителей недоступен.", true);
    }
  }

  async function fetchVisitCounter() {
    const urls = buildVisitCounterUrls();
    let lastError = null;

    for (let index = 0; index < urls.length; index += 1) {
      try {
        const response = await fetch(urls[index], {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          headers: {
            Accept: "application/json",
          },
        });
        const payload = await response.json();
        if (!response.ok || !payload || payload.ok !== true) {
          throw new Error(payload && payload.error ? payload.error : "Counter request failed");
        }
        return payload;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new Error("No visit counter URL available");
  }

  function setVisitCounterState(overall, today, note, isError) {
    dom.visitCounterOverall.textContent = overall;
    dom.visitCounterToday.textContent = today;
    dom.visitCounterNote.textContent = note;
    dom.visitCounterNote.classList.toggle("error", Boolean(isError));
  }

  function formatCounterNumber(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return "—";
    }
    return numeric.toLocaleString("ru-RU");
  }

  function buildVisitCounterUrls() {
    const urls = [];
    const proxyUrl = buildVisitCounterProxyUrl();
    if (proxyUrl) {
      urls.push(proxyUrl);
    }

    const legacyUrl = buildVisitCounterLegacyUrl();
    if (legacyUrl && urls.indexOf(legacyUrl) === -1) {
      urls.push(legacyUrl);
    }

    return urls;
  }

  function buildVisitCounterProxyUrl() {
    if (!window.location || !/^https?:$/.test(window.location.protocol)) {
      return null;
    }

    const pathname = window.location.pathname || "/";
    const normalizedPath = pathLooksLikeFile(pathname)
      ? pathname.slice(0, pathname.lastIndexOf("/") + 1)
      : pathname.replace(/\/?$/, "/");

    return window.location.origin + normalizedPath + "visit-counter";
  }

  function buildVisitCounterLegacyUrl() {
    if (!window.location || window.location.protocol !== "http:") {
      return null;
    }

    const host = window.location.hostname || "localhost";
    return "http://" + host + ":8123/visit-counter";
  }

  function pathLooksLikeFile(pathname) {
    const lastSegment = pathname.split("/").pop() || "";
    return /\.[A-Za-z0-9]+$/.test(lastSegment);
  }

  function scheduleChartDraw() {
    if (pendingChartFrame) {
      return;
    }
    pendingChartFrame = window.requestAnimationFrame(function () {
      pendingChartFrame = 0;
      drawChart();
    });
  }

  function runClientSelfTests() {
    try {
      const config = buildConfig(3, 3.0);
      const fourLossSummary = summarizeSequence([-1, -1, -1, -1]);
      const fourLossPayload = buildPlotPayload([-1, -1, -1, -1], config, fourLossSummary);
      assertArrayEqual(fourLossPayload.tradeIndices, [0, 1, 2, 3, 4], "trade indices");
      assertArrayApproxEqual(fourLossPayload.equityValues, [0.0, -1.0, -4.0, -13.0, -14.0], "equity values");
      assertAlmostEqual(fourLossPayload.metrics.peakStakeNormalized, 9.0, "peak stake");
      assertEqual(normalizeResetAfterLosses(4.0), 4, "normalize reset");
      assertAlmostEqual(normalizeLossMult(3.06), 3.1, "normalize mult");
      assertArrayApproxEqual(buildLossMultCandidates().slice(0, 3), [1.0, 1.1, 1.2], "mult candidates");
      assertArrayApproxEqual(buildLossMultSequence(4, 2.0), [1.0, 2.0, 4.0, 8.0], "step mult sequence");
      assertAlmostEqual(normalizeStepMultiplierValue("", 5), 1.0, "empty step mult");
      assertAlmostEqual(normalizeStepMultiplierValue("2,5", 1), 2.5, "comma step mult");
      assertEqual(parseMaxDrawdownLimit(""), null, "empty max dd");
      assertAlmostEqual(parseMaxDrawdownLimit("96,5"), 96.5, "decimal max dd");

      let negativeDdFailed = false;
      try {
        parseMaxDrawdownLimit("-1");
      } catch (_error) {
        negativeDdFailed = true;
      }
      assertEqual(negativeDdFailed, true, "negative max dd fails");

      const sortedValues = buildSequenceFromHistoryRecords([
        ["2026-04-05 03:30:00", 2.5, -2.5],
        ["2026-04-05 02:30:00", 2.5, 2.3],
        ["2026-04-05 02:56:00", 1.0, -1.0],
        ["2026-04-05 02:40:00", 3.0, 3.0],
        ["2026-04-05 02:20:00", 6.25, 5.75],
      ]);
      assertArrayEqual(sortedValues, [1, 1, -1, -1], "sorted sequence");

      const workbook = window.XLSX.utils.book_new();
      const worksheet = window.XLSX.utils.aoa_to_sheet([
        ["Direction", "Deal", "Expiration", "Asset", "Open time", "Close time", "Open price", "Close price", "Stake", "Profit"],
        ["put", "a", "S60", "X", "2026-04-05 03:30:00", "", 0, 0, 2.5, -2.5],
        ["put", "b", "S60", "X", "2026-04-05 02:30:00", "", 0, 0, 2.5, 2.3],
        ["put", "c", "S60", "X", "2026-04-05 02:40:00", "", 0, 0, 3.0, 3.0],
      ]);
      window.XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
      const workbookBuffer = window.XLSX.write(workbook, { type: "array", bookType: "xlsx" });
      const workbookData = {
        sheetName: "Sheet1",
        rows: window.XLSX.utils.sheet_to_json(
          window.XLSX.read(workbookBuffer, { type: "array", cellDates: true }).Sheets.Sheet1,
          { header: 1, raw: true, defval: null, blankrows: false }
        ),
      };
      const workbookSource = extractSequenceSource(workbookData, "history.xlsx");
      assertArrayEqual(workbookSource.sequence, [1, -1], "xlsx sequence");
      assertEqual(workbookSource.source.tradeCount, 2, "xlsx trade count");

      const statsSummary = summarizeSequence([1, -1, 1, -1]);
      const statsPayload = buildPlotPayload([1, -1, 1, -1], config, statsSummary);
      assertAlmostEqual(statsPayload.metrics.finalPnlNormalized, 1.68, "stats pnl");
      const kellySummary = summarizeSequence([1, -1, 1]);
      const kellyPayload = buildKellyPayload([1, -1, 1], buildKellyConfig(100, 2.0), kellySummary);
      assertArrayApproxEqual(kellyPayload.equityValues, [0.0, 1.84, -0.1968, 1.63957888], "kelly equity");
      assertAlmostEqual(kellyPayload.metrics.finalBalance, 101.63957888, "kelly final balance");
      assertAlmostEqual(kellyPayload.metrics.maxDrawdownNormalized, 2.0368, "kelly max dd");
      assertAlmostEqual(kellyPayload.metrics.peakStakeNormalized, 2.0368, "kelly peak position");
      const kellyMinStakePayload = buildKellyPayload([-1, -1, -1], buildKellyConfig(10, 2.0), summarizeSequence([-1, -1, -1]));
      assertArrayApproxEqual(kellyMinStakePayload.equityValues, [0.0, -1.0, -2.0, -3.0], "kelly min stake equity");
      assertAlmostEqual(kellyMinStakePayload.metrics.peakStakeNormalized, 1.0, "kelly min stake peak");
      assertAlmostEqual(normalizeKellyStartDeposit("999,5"), 999.5, "normalize kelly deposit");
      assertAlmostEqual(normalizeKellyPositionPct("10.9"), 10.0, "normalize kelly pct");
      const customConfig = buildConfig(4, 2.0);
      customConfig.lossMultSequence = [1.0, 1.5, 3.0, 10.0];
      const customPayload = buildPlotPayload([-1, -1, -1, 1], customConfig, summarizeSequence([-1, -1, -1, 1]));
      assertArrayApproxEqual(customPayload.equityValues, [0.0, -1.0, -2.5, -5.5, 3.7], "custom step mult payload");

      assertArrayEqual(
        collectEligibleBreakCandidateIndices([-1, -1, 1, 1, -1, -1, 1], 3),
        [2, 6],
        "manual break candidates"
      );
      const brokenSequence = buildEffectiveSequence([-1, -1, 1, 1, -1, -1, 1], [2]);
      assertArrayEqual(
        brokenSequence,
        [-1, -1, -1, 1, -1, -1, 1],
        "broken sequence"
      );
      assertArrayEqual(
        collectEligibleBreakCandidateIndices(brokenSequence, 3),
        [6],
        "manual break candidates after apply"
      );
      assertEqual(pickRandomItem([10, 20, 30], function () { return 0.5; }), 20, "random picker");
      const brokenPayload = buildPlotPayload(
        brokenSequence,
        config,
        summarizeSequence(brokenSequence)
      );
      assertAlmostEqual(brokenPayload.metrics.finalPnlNormalized, -7.8, "broken pnl");

      findBestProfitDrawdownConfigAsync(
        [-1, -1, 1, 1],
        summarizeSequence([-1, -1, 1, 1]),
        null,
        { yieldEvery: 0, resetCandidates: [2, 3], multCandidates: [1.0, 3.0] }
      ).then(function (best) {
        assertEqual(best.config.resetAfterLosses, 3, "best reset");
        assertAlmostEqual(best.config.lossMult, 3.0, "best mult");
        assertAlmostEqual(best.payload.metrics.recoveryFactor, 1.3, "best recovery");
        return findBestProfitDrawdownConfigAsync(
          [-1, -1, 1, 1],
          summarizeSequence([-1, -1, 1, 1]),
          2.0,
          { yieldEvery: 0, resetCandidates: [2, 3], multCandidates: [1.0, 3.0] }
        );
      }).then(function (capped) {
        assertEqual(capped.config.resetAfterLosses, 2, "capped reset");
        assertAlmostEqual(capped.config.lossMult, 1.0, "capped mult");
        return findBestProfitDrawdownConfigAsync(
          [-1, -1, 1, 1],
          summarizeSequence([-1, -1, 1, 1]),
          1.0,
          { yieldEvery: 0, resetCandidates: [2, 3], multCandidates: [1.0, 3.0] }
        );
      }).then(function () {
        throw new Error("impossible cap should fail");
      }).catch(function (error) {
        if (!String(error && error.message ? error.message : error).includes("Max DD <=")) {
          throw error;
        }
        setStatus("self-test: PASS", "success");
        document.body.setAttribute("data-self-test", "pass");
      }).catch(function (error) {
        setStatus("self-test: FAIL - " + (error && error.message ? error.message : String(error)), "error");
        document.body.setAttribute("data-self-test", "fail");
      });
    } catch (error) {
      setStatus("self-test: FAIL - " + (error && error.message ? error.message : String(error)), "error");
      document.body.setAttribute("data-self-test", "fail");
    }
  }

  function assertEqual(actual, expected, label) {
    if (actual !== expected) {
      throw new Error(label + ": expected " + expected + ", got " + actual);
    }
  }

  function assertAlmostEqual(actual, expected, label) {
    if (Math.abs(actual - expected) > 1e-6) {
      throw new Error(label + ": expected " + expected + ", got " + actual);
    }
  }

  function assertArrayEqual(actual, expected, label) {
    if (actual.length !== expected.length) {
      throw new Error(label + ": length mismatch");
    }
    for (let index = 0; index < actual.length; index += 1) {
      if (actual[index] !== expected[index]) {
        throw new Error(label + ": mismatch at index " + index);
      }
    }
  }

  function assertArrayApproxEqual(actual, expected, label) {
    if (actual.length !== expected.length) {
      throw new Error(label + ": length mismatch");
    }
    for (let index = 0; index < actual.length; index += 1) {
      if (Math.abs(actual[index] - expected[index]) > 1e-6) {
        throw new Error(label + ": mismatch at index " + index);
      }
    }
  }

  init();
})();
