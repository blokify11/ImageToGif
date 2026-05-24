require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

if (!token || !clientId) {
  console.error("Fehlende ENV-Variablen: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("imagetogif")
    .setDescription("Konvertiert eine PNG-Datei zu einem GIF")
    .addAttachmentOption((option) =>
      option
        .setName("png")
        .setDescription("PNG-Datei zum Konvertieren")
        .setRequired(true)
    )
    .setIntegrationTypes([0, 1]) // 0 = Guild Install, 1 = User Install
    .setContexts([0, 1, 2])      // 0 = Guild, 1 = Bot DM, 2 = Private Channel
    .toJSON(),
];

async function deploy() {
  const rest = new REST({ version: "10" }).setToken(token);
  try {
    console.log("Registriere globale Slash-Commands...");
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("Slash-Command /imagetogif global registriert (kann bis zu 1h dauern).");
  } catch (error) {
    console.error("Fehler beim Registrieren:", error);
    process.exit(1);
  }
}

deploy();
