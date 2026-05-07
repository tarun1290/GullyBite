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
    // pm2 reload sends a stop signal then SIGKILLs after kill_timeout.
    // ec2-server.js's _gracefulShutdown drains for up to 8s on
    // server.close + closes Mongo cleanly; 12s gives that path a 4s
    // buffer for slow Atlas teardowns before pm2 forces the kill.
    kill_timeout: 12000,
    // Switches the stop signal from SIGTERM to SIGINT so it matches
    // the SIGINT handler registered alongside SIGTERM in
    // ec2-server.js. Both handlers point at the same function so
    // either works in practice; aligning explicitly avoids surprises
    // if the handlers ever diverge.
    shutdown_with_message: true,
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
