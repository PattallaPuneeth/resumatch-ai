#!/usr/bin/env bash
set -e
echo "🌱 Seeding Database..."
(cd backend && npm run db:seed)
echo "✓ Database seeding completed."
