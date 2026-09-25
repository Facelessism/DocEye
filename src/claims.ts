import type { DocClaim, PackageManager, TextBlock } from "./types";

/**
 * Deterministic claim extraction. Only a handful of recognizable phrasings are
 * supported; everything else is ignored on purpose to keep false positives low.
 */

const LICENSE_PATTERNS: Array<[RegExp, string]> = [
  [/\bMIT\b/, "MIT"],
  [/\bApache(?:[- ]License)?[- ](?:Version )?2(?:\.0)?\b/, "Apache-2.0"],
  [/\b(?:GPL|GPLv)-?3(?:\.0)?(?:-only|-or-later|\+)?(?![\w.-])/, "GPL-3.0"],
  [/\b(?:GPL|GPLv)-?2(?:\.0)?(?:-only|-or-later|\+)?(?![\w.-])/, "GPL-2.0"],
  [/\bLGPL-?v?3(?:\.0)?(?:-only|-or-later|\+)?(?![\w.-])/, "LGPL-3.0"],
  [/\bAGPL-?v?3(?:\.0)?(?:-only|-or-later|\+)?(?![\w.-])/, "AGPL-3.0"],
  [/\bBSD[- ]3(?:[- ]Clause)?\b/, "BSD-3-Clause"],
  [/\bBSD[- ]2(?:[- ]Clause)?\b/, "BSD-2-Clause"],
  [/\bISC\b/, "ISC"],
  [/\bMPL[- ]?2(?:\.0)?\b/, "MPL-2.0"],
  [/\b(?:The )?Unlicense\b/, "Unlicense"],
];

export function findLicenseIds(text: string): string[] {
  const ids: string[] = [];
  for (const [pattern, id] of LICENSE_PATTERNS) {
    if (pattern.test(text)) ids.push(id);
  }
  return ids;
}

const PM = "(pnpm|yarn|npm|bun)";
/** "the npm registry", "the yarn API": the tool is mentioned as a service, not adopted. */
const NOT_A_SERVICE = "(?!\\s+(?:registry|api|packages?|ecosystem))";
const PM_CLAIMS = [
  new RegExp(`\\b(?:uses?|using|built with|powered by|managed (?:with|by))\\s+(?:the\\s+)?\`?${PM}\\b${NOT_A_SERVICE}`, "gi"),
  new RegExp(`\\bpackage manager\\b\\s*(?:is|:)?\\s*\`?${PM}\\b`, "gi"),
  new RegExp(`\\b(?:we|this (?:project|repo|repository|monorepo)|the (?:project|repo|repository))\\s+(?:use|uses|prefer|prefers|recommend|recommends|require|requires)\\s+(?:the\\s+)?\`?${PM}\\b${NOT_A_SERVICE}`, "gi"),
  new RegExp(`\\b(?:requires?|needs?)\\s+\`?${PM}\\b${NOT_A_SERVICE}`, "gi"),
];

const NODE_CLAIMS = [
  /\bnode(?:\.?js)?\s*(?:v|>=|≥)?\s*(\d{1,2})(?:\.\d+|\.x){0,2}\s*(?:\+|(?:or|and)\s+(?:newer|higher|later|above|greater))/gi,
  /\bnode(?:\.?js)?\s*(?:>=|≥)\s*v?(\d{1,2})/gi,
  /\b(?:minimum|min\.?)\s+node(?:\.?js)?\s+version\s*(?:is|:)?\s*v?(\d{1,2})/gi,
  /\bat least\s+node(?:\.?js)?\s*(?:version\s*)?v?(\d{1,2})/gi,
  /\bnode(?:\.?js)?\s*(?:version\s*)?v?(\d{1,2})(?:\.\d+|\.x){0,2}\s*(?:is\s+)?(?:required|needed|minimum)\b/gi,
  /\b(?:requires?|required|needs?|prerequisites?|requirements?)\b[^.\n]{0,40}?\bnode(?:\.?js)?\s*(?:version\s*)?(?:v|>=|≥)?\s*(\d{1,2})(?:\.\d+|\.x){0,2}/gi,
];

const DOCKER_CLAIMS = [
  /\b(?:supports?|supported|provides?|includes?|ships?(?: with)?)\s+(?:an?\s+|the\s+)?(?:official\s+)?docker\b/gi,
  /\bdocker(?:\s+(?:support|image|container|compose))?\s+(?:is\s+)?(?:supported|available|provided|included)\b/gi,
  /\bdocker support\b/gi,
  /\b(?:available|published|provided)\s+as\s+(?:an?\s+)?(?:official\s+)?docker\s+(?:image|container)\b/gi,
  /\b(?:run|runs|running)\s+(?:it\s+)?(?:in|with|using|via)\s+docker\b/gi,
  /\bdockerized\b|\bdocker[- ]ready\b/gi,
];

const CONFIG_CLAIMS = [
  /\b(?:config(?:uration)?(?:\s+files?)?|settings)\b[^.`\n]{0,30}?\b(?:lives?\s+in|(?:is|are)\s+(?:located|stored|found|kept|defined)\s+(?:in|at)|(?:can|may)\s+be\s+found\s+(?:in|at)|(?:is|are)\s+in|located\s+(?:in|at))\s+`([^`\s]+)`/gi,
  /\b(?:configured|configurable)\s+(?:in|via|using|through|with)\s+`([^`\s]+)`/gi,
  /\b(?:reads?|loads?)\s+(?:its\s+|the\s+)?(?:config(?:uration)?|settings)(?:\s+files?)?\s+from\s+`([^`\s]+)`/gi,
  /\bsee\s+`([^`\s]+)`\s+for\s+(?:the\s+)?(?:all\s+)?(?:config(?:uration)?|settings|options)\b/gi,
  /\bedit\s+`([^`\s]+)`\s+to\s+(?:configure|change\s+(?:the\s+)?(?:settings|config))/gi,
];

const LICENSE_TRIGGERS = [
  /\blicen[sc]e[ds]?\b([^.\n]{0,60})/gi,
  /\b(\S{2,30})\s+licen[sc]ed?\b/gi,
  /\b(?:released|distributed|available|published)\s+under\s+(?:the\s+)?([^.\n]{0,60})/gi,
];

/** Claim text for a license badge: the alt text, or the message of a shields.io `license-<id>` badge. */
export function licenseBadgeText(alt: string, url: string): string | undefined {
  const badge = url.split("/badge/")[1]?.split(/[?#]/)[0]?.replace(/\.(svg|png)$/i, "");
  if (badge !== undefined) {
    const [label, message] = badge.replace(/--/g, "\u0000").split("-");
    if (label !== undefined && message !== undefined && /^licen[cs]e$/i.test(label)) {
      return `License: ${message.replace(/\u0000/g, "-").replace(/_/g, " ")}`;
    }
  }
  return /licen[cs]e/i.test(alt) ? alt : undefined;
}

/** Only this much of one paragraph is scanned for claims, which bounds work on hostile input. */
const MAX_CLAIM_TEXT = 20_000;

function locate(block: TextBlock, index: number): { line: number; column: number } {
  const newlines = block.text.slice(0, index).split("\n").length - 1;
  return { line: block.line + newlines, column: newlines === 0 ? block.column : 1 };
}

export function extractClaims(block: TextBlock): DocClaim[] {
  const claims: DocClaim[] = [];
  const seen = new Set<string>();
  const add = (index: number, claim: DocClaim["claim"]): void => {
    const where = locate(block, index);
    const key = claim.kind === "node-version" ? `${where.line}:node:${claim.major}` : `${where.line}:${JSON.stringify(claim)}`;
    if (seen.has(key)) return;
    seen.add(key);
    claims.push({ file: block.file, ...where, claim });
  };
  const text = block.text.length > MAX_CLAIM_TEXT ? block.text.slice(0, MAX_CLAIM_TEXT) : block.text;

  for (const pattern of PM_CLAIMS) {
    for (const m of text.matchAll(pattern)) {
      add(m.index ?? 0, { kind: "package-manager", manager: (m[1] as string).toLowerCase() as PackageManager });
    }
  }

  for (const pattern of NODE_CLAIMS) {
    for (const m of text.matchAll(pattern)) {
      const major = Number(m[1]);
      const nodeAt = m[0].search(/node/i);
      add(m.index ?? 0, { kind: "node-version", major, text: m[0].slice(Math.max(nodeAt, 0)).trim() });
    }
  }

  for (const pattern of DOCKER_CLAIMS) {
    for (const m of text.matchAll(pattern)) add(m.index ?? 0, { kind: "docker-support" });
  }

  for (const pattern of CONFIG_CLAIMS) {
    for (const m of text.matchAll(pattern)) add(m.index ?? 0, { kind: "config-location", path: m[1] as string });
  }

  for (const pattern of LICENSE_TRIGGERS) {
    for (const m of text.matchAll(pattern)) {
      for (const id of findLicenseIds(m[1] as string)) add(m.index ?? 0, { kind: "license", id });
    }
  }
  if (block.section !== undefined && /licen[sc]e/i.test(block.section)) {
    const lead = /^\s*(?:the\s+)?([^\n]{0,40})/i.exec(text);
    const first = lead ? findLicenseIds(lead[1] as string)[0] : undefined;
    if (first !== undefined && /^\s*(?:the\s+)?(?:MIT|Apache|GPL|LGPL|AGPL|BSD|ISC|MPL|Unlicense|The Unlicense)/.test(text)) {
      add(0, { kind: "license", id: first });
    }
  }

  return claims;
}
