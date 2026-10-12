Write-Host "==> Running Tests across all services..." -ForegroundColor Cyan

Write-Host "--> [1/3] Backend Vitest Suite:" -ForegroundColor Yellow
Push-Location backend
npm test
$backendResult = $LASTEXITCODE
Pop-Location

Write-Host "--> [2/3] ML Pytest Suite:" -ForegroundColor Yellow
python -m pytest ml/tests
$mlResult = $LASTEXITCODE

Write-Host "--> [3/3] Frontend Vitest Suite:" -ForegroundColor Yellow
Push-Location frontend
npm test
$frontendResult = $LASTEXITCODE
Pop-Location

if ($backendResult -ne 0 -or $mlResult -ne 0 -or $frontendResult -ne 0) {
    Write-Host "FAILED: One or more test suites failed." -ForegroundColor Red
    exit 1
} else {
    Write-Host "SUCCESS: All test suites passed successfully!" -ForegroundColor Green
}
