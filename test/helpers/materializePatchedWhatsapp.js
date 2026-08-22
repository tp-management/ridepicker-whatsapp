import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PATCH_CHAIN = [
  ["applyWhatsappPairingHardening.js", "applyWhatsappPairingHardening"],
  ["applyWhatsappPairingHelloAck.js", "applyWhatsappPairingHelloAck"],
  ["applyWhatsappPairingUx.js", "applyWhatsappPairingUx"],
  ["applyWhatsappPairingFeedback.js", "applyWhatsappPairingFeedback"],
  ["applyBaileysRawUiErrors.js", "applyBaileysRawUiErrors"],
  ["applyWhatsappRemoteLogout.js", "applyWhatsappRemoteLogout"],
  ["applyBaileysRawLogging.js", "applyBaileysRawLogging"],
];

export function patchCallOrderFromIndex(source) {
  return [...source.matchAll(/^\s*(apply(?:Whatsapp|Baileys)\w+)\(\);\s*$/gm)].map(
    (match) => match[1]
  );
}

export async function materializeCurrentPatchedWhatsapp({
  repoRoot = process.cwd(),
  baseWhatsappPath = path.join(
    repoRoot,
    "test",
    "fixtures",
    "whatsapp.pre-canonical.js"
  ),
} = {}) {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "ridepicker-whatsapp-patched-")
  );
  const tempSrc = path.join(tempRoot, "src");
  await fs.mkdir(tempSrc, { recursive: true });

  await fs.copyFile(baseWhatsappPath, path.join(tempSrc, "whatsapp.js"));

  for (const [fileName] of PATCH_CHAIN) {
    await fs.copyFile(
      path.join(repoRoot, "src", fileName),
      path.join(tempSrc, fileName)
    );
  }

  for (let index = 0; index < PATCH_CHAIN.length; index += 1) {
    const [fileName, exportName] = PATCH_CHAIN[index];
    const moduleUrl = `${pathToFileURL(path.join(tempSrc, fileName)).href}?step=${index}`;
    const patchModule = await import(moduleUrl);
    const applyPatch = patchModule[exportName];

    if (typeof applyPatch !== "function") {
      throw new Error(`${fileName} does not export ${exportName}`);
    }

    const applied = applyPatch();
    if (applied !== true) {
      throw new Error(`${exportName} did not apply exactly once`);
    }
  }

  const source = await fs.readFile(path.join(tempSrc, "whatsapp.js"), "utf8");

  return {
    source,
    tempRoot,
    async cleanup() {
      await fs.rm(tempRoot, { recursive: true, force: true });
    },
  };
}
