# Equity Viewer

Веб-приложение для анализа истории сделок Pocket Option из Excel-отчета `.xlsx`.

Страница загружает файл прямо в браузере, строит реальную кривую equity по колонке `J`, рассчитывает альтернативную кривую мартингейла по последовательности сделок и позволяет подбирать параметры money management без ручных пересчетов. Основная математика повторяет логику из `plot_otch_equity.py`, а интерфейс развертывается как статический сайт под IIS.

## Что умеет

- загружает первый лист `.xlsx`
- сортирует историю по колонке `E`
- формирует последовательность сделок по правилам из Python-скрипта
- строит две линии на одном графике:
  - реальное equity
  - расчетный equity мартингейла
- автоматически подбирает стартовые параметры мартингейла под реальную кривую
- показывает ключевую статистику:
  - `Ratio`
  - `Итоговый PnL`
  - `Max drawdown`
  - `Peak stake`
  - `Сделок`
  - `Плюсовых`
  - `Минусовых`
  - `Winrate`
  - `Max loss streak`
- поддерживает ручные правки последовательности кнопками `<` и `>`
- показывает счетчик посещений: всего и за сегодня

## Как устроен проект

- [equity-viewer/index.html](C:/Calc_Equity/equity-viewer/index.html) - основная страница
- [equity-viewer/styles.css](C:/Calc_Equity/equity-viewer/styles.css) - стили интерфейса
- [equity-viewer/app.js](C:/Calc_Equity/equity-viewer/app.js) - клиентская логика парсинга, расчета и рисования графика
- [equity-viewer/vendor/xlsx.full.min.js](C:/Calc_Equity/equity-viewer/vendor/xlsx.full.min.js) - SheetJS для чтения Excel в браузере
- [equity-viewer/web.config](C:/Calc_Equity/equity-viewer/web.config) - конфиг статического сайта для IIS
- [scripts/deploy_equity_viewer_iis.ps1](C:/Calc_Equity/scripts/deploy_equity_viewer_iis.ps1) - деплой в `C:\inetpub\wwwroot\equity-viewer`
- [scripts/visit_counter_service.py](C:/Calc_Equity/scripts/visit_counter_service.py) - сервис счетчика посещений на порту `8123`
- [plot_otch_equity.py](C:/Calc_Equity/plot_otch_equity.py) - исходный desktop-инструмент, от которого взята логика расчета

## Логика расчета

Из Excel берется первый лист. После сортировки по колонке `E` каждая строка превращается в:

- `+1`, если `J > 0` и `J != I`
- `-1`, если `J < 0`
- остальные строки пропускаются

Для реального equity используется накопительная сумма значений из колонки `J`.

Для мартингейла используются параметры:

- базовая ставка: `1 USD`
- payout: `92%`
- `Reset after losses`
- `Martingale multiplier`

После выигрыша ставка сбрасывается к базовой. После `N` подряд минусов следующая ставка тоже сбрасывается к базовой.

## Ручные правки последовательности

Под графиком есть блок `< 0 >`.

- `<` случайно переводит одну подходящую завершающую плюсовую сделку в минус
- число в центре показывает количество примененных ручных правок
- `>` отменяет последнюю ручную правку

Эти правки влияют только на расчетную кривую мартингейла. Реальное equity из Excel не меняется.

## Развертывание

Проект рассчитан на Windows Server + IIS.

Основной способ деплоя:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Calc_Equity\scripts\deploy_equity_viewer_iis.ps1
```

Скрипт:

- копирует сайт в `C:\inetpub\wwwroot\equity-viewer`
- обновляет IIS-приложение `/equity-viewer`
- подготавливает Python runtime для служебного сервиса
- регистрирует и запускает `visit_counter_service.py`

После деплоя страница доступна по адресу вида:

```text
http://<server>/equity-viewer/
```

## Особенности v1

- вся обработка `.xlsx` происходит в браузере
- торговые файлы не сохраняются на сервере
- backend не участвует в расчете графика
- отдельный Python-сервис используется только для счетчика посещений

