Write-Host "🌱 Seeding Database..." -ForegroundColor Cyan
Push-Location backend
npm run db:seed
Pop-Location
Write-Host "✓ Database seeding completed." -ForegroundColor Green
