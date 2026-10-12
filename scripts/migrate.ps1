Write-Host "📦 Applying Prisma Database Migrations..." -ForegroundColor Cyan
Push-Location backend
npx prisma migrate deploy
Pop-Location
Write-Host "✓ Migrations applied successfully." -ForegroundColor Green
