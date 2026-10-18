// Entropy control (principle 9.2): scan the whole target with the maintainability sensors and stale-doc checks,
// and propose small cleanup tasks. Proposals are drafts: a human writes acceptance cases and approves intent (1.1).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { checkMaintainability } from './gates/maintainability.mjs';
import { ensureDir, listFiles, matchesAny, nowIso, writeJsonAtomic } from './util.mjs';
import { openStore } from './store.mjs';

export function staleDocLinks(targetDir) {
  const findings = [];
  for (const file of listFiles(targetDir).filter((f) => f.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(targetDir, file), 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const href = m[1];
        if (/^[a-z]+:/i.test(href)) continue;
        if (!fs.existsSync(path.resolve(targetDir, path.dirname(file), href))) {
          findings.push({ rule: 'stale-doc-link', file, line: i + 1, message: `${file}:${i + 1} links to ${href}, which does not exist. Fix or remove the link.`, remediation: 'fix or remove the link' });
        }
      }
    });
  }
  return findings;
}

export function gc({ controlDir, targetDir, storeDir, maxProposals = 5 }) {
  const config = loadConfig(controlDir);
  const files = listFiles(targetDir).filter((f) => matchesAny(f, config.profile.sourceGlobs) && !matchesAny(f, config.profile.testGlobs));
  const sensor = checkMaintainability({ root: targetDir, files, rules: config.rules });
  const findings = [...(sensor.evidence?.findings ?? []), ...staleDocLinks(targetDir)];
  const byRule = new Map();
  for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  const store = openStore(storeDir);
  const dir = ensureDir(path.join(store.dir, 'gc', 'proposals'));
  const proposals = [];
  for (const [rule, items] of byRule) {
    for (const item of items) {
      if (proposals.length >= maxProposals) break;
      const id = `gc-${rule}-${proposals.length + 1}`;
      const proposal = {
        status: 'draft', proposedAt: nowIso(),
        needs: ['acceptance cases (visible tests and/or holdouts)', 'non-functionals', 'intent approval by a human'],
        task: { schemaVersion: 1, id, title: `Cleanup: ${rule} in ${item.file}`, intent: item.message, size: 'small' },
        finding: item,
      };
      writeJsonAtomic(path.join(dir, `${id}.json`), proposal);
      proposals.push(proposal);
    }
  }
  return { sensorVerdict: sensor.verdict, findings: findings.length, proposals };
}
