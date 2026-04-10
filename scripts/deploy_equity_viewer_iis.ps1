[CmdletBinding()]
param(
    [string]$SourcePath = "C:\Calc_Equity\equity-viewer",
    [string]$SiteName = "Default Web Site",
    [string]$ApplicationName = "equity-viewer",
    [string]$DeployPath = "C:\inetpub\wwwroot\equity-viewer"
)

$ErrorActionPreference = "Stop"

Import-Module WebAdministration

if (-not (Test-Path -LiteralPath $SourcePath)) {
    throw "Source path not found: $SourcePath"
}

$pythonSourcePath = (Get-Command python -ErrorAction Stop).Source
$pythonSourceRoot = Split-Path -Path $pythonSourcePath -Parent
$pythonRuntimeRoot = "C:\inetpub\python-runtime\Python313"
$pythonPath = Join-Path $pythonRuntimeRoot "python.exe"
$visitCounterServiceScript = "C:\Calc_Equity\scripts\visit_counter_service.py"
$visitCounterTaskName = "CalcEquityVisitCounter"
$visitCounterFirewallRule = "Calc Equity Visit Counter 8123"
$dataPath = Join-Path $DeployPath "data"
$deployWebConfigPath = Join-Path $DeployPath "web.config"
$rewriteModuleName = "RewriteModule"
$visitCounterHealthUrl = "http://127.0.0.1:8123/visit-counter"
$baseWebConfig = @"
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <defaultDocument enabled="true">
      <files>
        <clear />
        <add value="index.html" />
      </files>
    </defaultDocument>
    <staticContent>
      <remove fileExtension=".json" />
      <mimeMap fileExtension=".json" mimeType="application/json" />
    </staticContent>
    <httpProtocol>
      <customHeaders>
        <add name="X-Content-Type-Options" value="nosniff" />
        <add name="Referrer-Policy" value="same-origin" />
      </customHeaders>
    </httpProtocol>
  </system.webServer>
</configuration>
"@
$proxyWebConfig = @"
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <defaultDocument enabled="true">
      <files>
        <clear />
        <add value="index.html" />
      </files>
    </defaultDocument>
    <staticContent>
      <remove fileExtension=".json" />
      <mimeMap fileExtension=".json" mimeType="application/json" />
    </staticContent>
    <rewrite>
      <rules>
        <rule name="VisitCounterProxy" stopProcessing="true">
          <match url="^visit-counter/?$" />
          <action type="Rewrite" url="http://127.0.0.1:8123/visit-counter" logRewrittenUrl="true" />
        </rule>
      </rules>
    </rewrite>
    <httpProtocol>
      <customHeaders>
        <add name="X-Content-Type-Options" value="nosniff" />
        <add name="Referrer-Policy" value="same-origin" />
      </customHeaders>
    </httpProtocol>
  </system.webServer>
</configuration>
"@

function Wait-VisitCounterHealthy {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 20
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3 -Headers @{ Accept = "application/json" }
            if ($response.StatusCode -eq 200) {
                $payload = $response.Content | ConvertFrom-Json
                if ($payload -and $payload.ok -eq $true) {
                    return $payload
                }
            }
        } catch {
        }

        Start-Sleep -Milliseconds 700
    } while ((Get-Date) -lt $deadline)

    return $null
}

$existingTaskBeforeCopy = Get-ScheduledTask -TaskName $visitCounterTaskName -ErrorAction SilentlyContinue
if ($existingTaskBeforeCopy) {
    Stop-ScheduledTask -TaskName $visitCounterTaskName -ErrorAction SilentlyContinue
}
$listener = Get-NetTCPConnection -LocalPort 8123 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
}

New-Item -ItemType Directory -Force -Path $pythonRuntimeRoot | Out-Null
Copy-Item -Path (Join-Path $pythonSourceRoot "*") -Destination $pythonRuntimeRoot -Recurse -Force

New-Item -ItemType Directory -Force -Path $DeployPath | Out-Null
Copy-Item -Path (Join-Path $SourcePath "*") -Destination $DeployPath -Recurse -Force
New-Item -ItemType Directory -Force -Path $dataPath | Out-Null

$deployWebConfigContent = $baseWebConfig
$rewriteModule = Get-WebGlobalModule -Name $rewriteModuleName -ErrorAction SilentlyContinue
$proxySection = Get-WebConfiguration -PSPath "MACHINE/WEBROOT/APPHOST" -Filter "system.webServer/proxy" -ErrorAction SilentlyContinue
if ($rewriteModule -and $proxySection) {
    Set-WebConfigurationProperty -PSPath "MACHINE/WEBROOT/APPHOST" -Filter "system.webServer/proxy" -Name "enabled" -Value "True"
    Set-WebConfigurationProperty -PSPath "MACHINE/WEBROOT/APPHOST" -Filter "system.webServer/proxy" -Name "preserveHostHeader" -Value "True"
    Set-WebConfigurationProperty -PSPath "MACHINE/WEBROOT/APPHOST" -Filter "system.webServer/proxy" -Name "reverseRewriteHostInResponseHeaders" -Value "False"
    $deployWebConfigContent = $proxyWebConfig
    Write-Host "Configured IIS reverse proxy for /$ApplicationName/visit-counter"
} elseif ($rewriteModule) {
    Write-Warning "IIS URL Rewrite is installed, but ARR proxy is unavailable. Install Application Request Routing to proxy /visit-counter through IIS."
} else {
    Write-Warning "IIS URL Rewrite module is unavailable. The visit counter will keep using direct port 8123 fallback."
}
Set-Content -LiteralPath $deployWebConfigPath -Value $deployWebConfigContent -Encoding UTF8

$existingApp = Get-WebApplication -Site $SiteName -Name $ApplicationName -ErrorAction SilentlyContinue
if (-not $existingApp) {
    New-WebApplication -Site $SiteName -Name $ApplicationName -PhysicalPath $DeployPath | Out-Null
} else {
    Set-ItemProperty "IIS:\Sites\$SiteName\$ApplicationName" -Name physicalPath -Value $DeployPath
}

icacls $pythonRuntimeRoot /grant "IIS AppPool\DefaultAppPool:(OI)(CI)RX" /t | Out-Null
icacls $pythonRuntimeRoot /grant "IIS_IUSRS:(OI)(CI)RX" /t | Out-Null
icacls $pythonRuntimeRoot /grant "IUSR:(OI)(CI)RX" /t | Out-Null
icacls $DeployPath /grant "IIS AppPool\DefaultAppPool:(OI)(CI)RX" /t | Out-Null
icacls $dataPath /grant "IIS AppPool\DefaultAppPool:(OI)(CI)M" /t | Out-Null
icacls $DeployPath /grant "IIS_IUSRS:(OI)(CI)RX" /t | Out-Null
icacls $DeployPath /grant "IUSR:(OI)(CI)RX" /t | Out-Null

if (-not (Get-NetFirewallRule -DisplayName $visitCounterFirewallRule -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $visitCounterFirewallRule -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8123 | Out-Null
}

$existingTask = Get-ScheduledTask -TaskName $visitCounterTaskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Stop-ScheduledTask -TaskName $visitCounterTaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $visitCounterTaskName -Confirm:$false
}

$taskAction = New-ScheduledTaskAction -Execute $pythonPath -Argument "`"$visitCounterServiceScript`""
$taskTrigger = New-ScheduledTaskTrigger -AtStartup
$taskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$taskSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
    -TaskName $visitCounterTaskName `
    -Action $taskAction `
    -Trigger $taskTrigger `
    -Principal $taskPrincipal `
    -Settings $taskSettings `
    | Out-Null

Start-ScheduledTask -TaskName $visitCounterTaskName

$visitCounterPayload = Wait-VisitCounterHealthy -Url $visitCounterHealthUrl -TimeoutSeconds 20
if (-not $visitCounterPayload) {
    $taskState = (Get-ScheduledTask -TaskName $visitCounterTaskName -ErrorAction SilentlyContinue).State
    throw "Visit counter service did not become healthy on $visitCounterHealthUrl. Task state: $taskState"
}

Write-Host ("Visit counter is healthy. Overall unique visitors: {0}, today: {1}" -f `
    $visitCounterPayload.overallUniqueVisitors, `
    $visitCounterPayload.todayUniqueVisitors)

Write-Host "Deployed to http://localhost/$ApplicationName/"
