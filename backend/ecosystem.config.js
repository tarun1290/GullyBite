// PM2 Ecosystem Configuration — GullyBite EC2 Webhook Backend
// Start: pm2 start ecosystem.config.js
// Restart: pm2 restart gullybite-backend
// Logs: pm2 logs gullybite-backend
// Status: pm2 status

module.exports = {
  apps: [{
    name: 'gullybite-backend',
    script: 'ec2-server.js',
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
