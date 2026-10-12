Write-Host "==> Running Linters and Typecheck across all services..." -ForegroundColor Cyan

Write-Host "--> [1/3] Backend Build and Typecheck:" -ForegroundColor Yellow
Push-Location backend
npm run build
$backendResult = $LASTEXITCODE
Pop-Location

Write-Host "--> [2/3] ML Ruff and Mypy:" -ForegroundColor Yellow
python -m ruff check ml
$ruffResult = $LASTEXITCODE
python -m mypy --config-file ml/pyproject.toml ml
$mypyResult = $LASTEXITCODE

Write-Host "--> [3/3] Frontend Typecheck:" -ForegroundColor Yellow
Push-Location frontend
npm run typecheck
$frontendResult = $LASTEXITCODE
Pop-Location

if ($backendResult -ne 0 -or $ruffResult -ne 0 -or $mypyResult -ne 0 -or $frontendResult -ne 0) {
    Write-Host "FAILED: One or more checks failed." -ForegroundColor Red
    exit 1
} else {
    Write-Host "SUCCESS: All services passed lint and typecheck!" -ForegroundColor Green
}
