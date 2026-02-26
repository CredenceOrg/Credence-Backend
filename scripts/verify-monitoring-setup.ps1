# Verification script for Grafana monitoring setup
Write-Host "Verifying Credence Backend Monitoring Setup..." -ForegroundColor Cyan
Write-Host ""

$Errors = 0

function Test-FileExists {
    param($Path)
    if (Test-Path $Path) {
        Write-Host "[OK] $Path" -ForegroundColor Green
        return $true
    } else {
        Write-Host "[MISSING] $Path" -ForegroundColor Red
        $script:Errors++
        return $false
    }
}

Write-Host "Checking directory structure..." -ForegroundColor Yellow
Test-FileExists "monitoring" | Out-Null
Test-FileExists "monitoring/grafana" | Out-Null
Test-FileExists "monitoring/prometheus" | Out-Null
Write-Host ""

Write-Host "Checking configuration files..." -ForegroundColor Yellow
Test-FileExists "monitoring/grafana/dashboard.json" | Out-Null
Test-FileExists "monitoring/prometheus/prometheus.yml" | Out-Null
Test-FileExists "monitoring/prometheus/alerts.yml" | Out-Null
Test-FileExists "docker-compose.yml" | Out-Null
Write-Host ""

Write-Host "Checking documentation..." -ForegroundColor Yellow
Test-FileExists "docs/monitoring.md" | Out-Null
Test-FileExists "monitoring/README.md" | Out-Null
Test-FileExists "MONITORING_QUICKSTART.md" | Out-Null
Write-Host ""

Write-Host "Checking implementation files..." -ForegroundColor Yellow
Test-FileExists "src/middleware/metrics.example.ts" | Out-Null
Write-Host ""

if ($Errors -eq 0) {
    Write-Host "All checks passed!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "1. npm install prom-client"
    Write-Host "2. docker-compose up -d"
    Write-Host "3. Open http://localhost:3001 (admin/admin)"
} else {
    Write-Host "Found $Errors errors" -ForegroundColor Red
}
