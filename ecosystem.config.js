module.exports = {
  apps: [
    {
      name: "imagetogif",
      script: "server.js",
      cwd: "/root/imagetogif",
      env: {
        PORT: 3000,
        NODE_ENV: "production",
        ADMIN_TOKEN: "changeme",
      },
    },
    {
      name: "imagetogif-discord",
      script: "discord-bot.js",
      cwd: "/root/imagetogif",
      env: {
        DISCORD_BOT_TOKEN: "",
        DISCORD_CLIENT_ID: "",
      },
    },
  ],
};
