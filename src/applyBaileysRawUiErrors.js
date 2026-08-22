import fs from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const whatsappPath = fileURLToPath(new URL("./whatsapp.js", import.meta.url));
const marker = "const BAILEYS_RAW_UI_ERRORS_V1 = true;";

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);

  if (first === -1 || first !== last) {
    throw new Error(
      `Baileys raw UI error target mismatch (${label}). Expected exactly one match.`
    );
  }

  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function applyBaileysRawUiErrors() {
  const original = fs.readFileSync(whatsappPath, "utf8");

  if (original.includes(marker)) {
    return false;
  }

  let source = original;

  source = replaceExactlyOnce(
    source,
    `const WA_PAIRING_FEEDBACK_V1 = true;`,
    `const WA_PAIRING_FEEDBACK_V1 = true;\n${marker}`,
    "marker"
  );

  source = replaceExactlyOnce(
    source,
    `    const error = new Error(\n      "WhatsApp is temporarily limiting new connection codes. Please wait a few minutes before trying again."\n    );`,
    `    const error = new Error(\n      flow.lastError?.message || "rate-overlimit"\n    );`,
    "cooldown raw error"
  );

  source = replaceExactlyOnce(
    source,
    `    flow.lastError = {\n      code: "RATE_LIMITED",\n      message:\n        "WhatsApp is temporarily limiting new connection codes. RidePicker stopped retrying automatically. Please wait a few minutes before trying again.",\n    };`,
    `    flow.lastError = {\n      code: "RATE_LIMITED",\n      message: String(message || "rate-overlimit"),\n      upstreamStatusCode: statusCode ?? null,\n    };`,
    "rate limit raw message"
  );

  source = replaceExactlyOnce(
    source,
    `      title: "WhatsApp temporarily limited new codes",\n      message: flow.lastError.message,`,
    `      title: flow.lastError.message,\n      message: flow.lastError.message,`,
    "rate limit notice raw message"
  );

  source = replaceExactlyOnce(
    source,
    `    const error = new Error(\n      flow.notice?.message ||\n        flow.lastError.message ||\n        "Could not create a WhatsApp connection code."\n    );`,
    `    const error = new Error(\n      flow.lastError.message || "Unknown Baileys error"\n    );`,
    "POST raw error"
  );

  fs.writeFileSync(whatsappPath, source);

  const check = spawnSync(process.execPath, ["--check", whatsappPath], {
    encoding: "utf8",
  });

  if (check.status !== 0) {
    fs.writeFileSync(whatsappPath, original);
    throw new Error(
      `Generated Baileys raw UI error patch failed syntax check: ${check.stderr || check.stdout}`
    );
  }

  console.log("[whatsapp] raw Baileys pairing errors enabled");
  return true;
}
