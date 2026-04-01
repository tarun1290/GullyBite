#!/bin/bash
# Deploy script for GullyBite EC2 Webhook Backend
# Run from the project root on the EC2 instance:
#   cd /home/ubuntu/gullybite && bash backend/deploy.sh
#
# First-time setup (run once):
#   chmod +x backend/deploy.sh
#   npm install -g pm2
#   mkdir -p backend/logs

set -e

echo "🚀 GullyBite EC2 Deploy"
echo "========================"

echo "📥 Pulling latest code..."
git pull origin main

echo "📦 Installing dependencies..."
cd backend
npm install --production

echo "🔄 Restarting backend..."
pm2 restart gullybite-backend 2>/dev/null || pm2 start ecosystem.config.js

echo ""
echo "✅ Deploy complete!"
pm2 status
echo ""
echo "📋 View logs: pm2 logs gullybite-backend"
