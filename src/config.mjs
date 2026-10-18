// Control configuration: factory.json, policy.json, rules.json, knowledge and evaluators.
// Principles: 5.1 (trifecta), 5.4 (config as a supply chain: digest + human approval), 8.3 (AI policy), 9.4 (profiles).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValid } from './schema.mjs';
import { FactoryError, listFiles, readJson, sha256, hashFile } from './util.mjs';

export const FACTORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const capabilities = {
  type: 'object', required: ['privateData', 'untrustedContent', 'externalComms'],
  properties: { privateData: { type: 'boolean' }, untrustedContent: { type: 'boolean' }, externalComms: { type: 'boolean' } },
};
const role = {
  type: 'object', required: ['capabilities', 'tools'],
  properties: { capabilities, tools: { type: 'array', items: { type: 'string' } }, model: { type: 'string' } },
};
const factorySchema = {
  type: 'object',
  required: ['schemaVersion', 'name', 'profile', 'agent', 'roles', 'budgets', 'gates', 'autonomy', 'review', 'escalation'],
  properties: {
    schemaVersion: { enum: [1] },
    name: { type: 'string', minLength: 1 },
    profile: { type: 'string', minLength: 1 },
    agent: {
      type: 'object', required: ['adapter', 'model'],
      properties: { adapter: { enum: ['claude', 'scripted', 'command'] }, model: { type: 'string' }, reviewModel: { type: 'string' },
        command: { type: 'array', items: { type: 'string' } } },
    },
    roles: { type: 'object', required: ['builder'], additionalProperties: role },
    budgets: {
      type: 'object', required: ['maxAttempts', 'runUsd', 'dailyUsd', 'agentTimeoutMs'],
      properties: { maxAttempts: { type: 'integer', minimum: 1 }, runUsd: { type: 'number', minimum: 0 },
        dailyUsd: { type: 'number', minimum: 0 }, agentTimeoutMs: { type: 'integer', minimum: 1000 } },
    },
    gates: {
      type: 'object', required: ['order'],
      properties: { order: { type: 'array', minItems: 1, items: { type: 'string' } }, repeat: { type: 'integer', minimum: 1 },
        diffBudgetLines: { type: 'integer', minimum: 1 },
        mutation: { type: 'object', properties: { maxMutants: { type: 'integer', minimum: 1 }, minScore: { type: 'number', minimum: 0 } } } },
    },
    autonomy: {
      type: 'object', required: ['classes', 'default'],
      properties: {
        classes: { type: 'array', items: { type: 'object', required: ['name', 'paths', 'tier'],
          properties: { name: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } },
            tier: { enum: ['auto', 'one-human', 'two-humans'] }, earnable: { type: 'boolean' } } } },
        default: { enum: ['auto', 'one-human', 'two-humans'] },
        promoteAfter: { type: 'integer', minimum: 1 },
      },
    },
    review: { type: 'object', required: ['wipLimit'], properties: { wipLimit: { type: 'integer', minimum: 1 } } },
    escalation: { type: 'object', required: ['owner', 'defaultAfterHours', 'defaultAction'],
      properties: { owner: { type: 'string' }, defaultAfterHours: { type: 'number', minimum: 0 }, defaultAction: { enum: ['abandon'] } } },
    context: { type: 'object', properties: { mapMaxLines: { type: 'integer', minimum: 10 } } },
    trace: { type: 'object', properties: { captureContent: { type: 'boolean' } } },
    holdouts: { type: 'object', properties: { requireSealed: { type: 'boolean' }, keyEnv: { type: 'string' } } },
    readiness: { type: 'object', properties: { maxAgeDays: { type: 'number', minimum: 0 } } },
    observe: { type: 'object', additionalProperties: { type: 'string' } },
  },
};
const policySchema = {
  type: 'object', required: ['approvedModels', 'approvedTools', 'unattendedClasses', 'dataBoundary', 'attribution'],
  properties: {
    approvedModels: { type: 'array', minItems: 1, items: { type: 'string' } },
    approvedTools: { type: 'array', items: { type: 'string' } },
    unattendedClasses: { type: 'array', items: { type: 'string' } },
    dataBoundary: { type: 'object', required: ['denyGlobs'], properties: { denyGlobs: { type: 'array', items: { type: 'string' } } } },
    attribution: { type: 'object', required: ['trailer'], properties: { trailer: { type: 'string', minLength: 1 } } },
    approvers: { type: 'array', items: { type: 'string' } },
    allowUnconfinedAgent: { type: 'boolean' },
  },
};
const profileSchema = {
  type: 'object', required: ['name', 'commands', 'sourceGlobs', 'testGlobs'],
  properties: {
    name: { type: 'string' },
    commands: { type: 'object', required: ['test'], additionalProperties: {
      type: 'object', required: ['argv', 'parse'],
      properties: { argv: { type: 'array', minItems: 1, items: { type: 'string' } }, parse: { enum: ['tap', 'exit'] }, timeoutMs: { type: 'integer' } } } },
    sourceGlobs: { type: 'array', items: { type: 'string' } },
    testGlobs: { type: 'array', items: { type: 'string' } },
    observe: { type: 'object' },
  },
};

export function loadProfile(name, controlDir) {
  const local = path.join(controlDir, 'profiles', `${name}.json`);
  const builtin = path.join(FACTORY_ROOT, 'profiles', `${name}.json`);
  const file = fs.existsSync(local) ? local : builtin;
  if (!fs.existsSync(file)) throw new FactoryError('PROFILE', `unknown profile ${name}`);
  return { ...assertValid(readJson(file), profileSchema, `profile ${name}`), file };
}

// Roles that combine private data, untrusted content and external communication can turn prompt injection
// into exfiltration (principle 5.1). Refuse such a configuration outright.
export function checkTrifecta(roles) {
  const offenders = Object.entries(roles)
    .filter(([, r]) => r.capabilities.privateData && r.capabilities.untrustedContent && r.capabilities.externalComms)
    .map(([name]) => name);
  if (offenders.length) {
    throw new FactoryError('TRIFECTA', `role(s) ${offenders.join(', ')} hold the lethal trifecta (private data + untrusted content + external communication); remove one capability or put a human gate in front`);
  }
  const network = ['WebFetch', 'WebSearch'];
  for (const [name, r] of Object.entries(roles)) {
    if (!r.capabilities.externalComms && r.tools.some((t) => network.includes(t))) {
      throw new FactoryError('TRIFECTA', `role ${name} declares no external communication but lists network tools`);
    }
  }
}

// Every policy-bearing file in control, hashed into one digest. Tasks and holdouts have their own digests.
export function configFiles(controlDir) {
  const files = listFiles(controlDir).filter((f) => !f.startsWith('tasks/') && !f.startsWith('holdouts/'));
  return files.filter((f) => /^(factory|policy|rules)\.json$/.test(f) || f === 'behaviours.mjs' || /^(knowledge|evaluators|profiles|briefs|candidates)\//.test(f));
}

export function configDigest(controlDir, profileFile) {
  const parts = configFiles(controlDir).map((f) => `${f}\0${hashFile(path.join(controlDir, f))}`);
  if (profileFile) parts.push(`profile\0${hashFile(profileFile)}`);
  return sha256(parts.join('\n'));
}

export const KNOWN_GATES = ['integrity', 'diff', 'maintainability', 'visible-tests', 'repeat', 'mutation', 'holdouts', 'review'];

export function loadConfig(controlDir, { skipTrifecta = false } = {}) {
  const abs = path.resolve(controlDir);
  const factory = assertValid(readJson(path.join(abs, 'factory.json')), factorySchema, 'factory.json');
  const policy = assertValid(readJson(path.join(abs, 'policy.json')), policySchema, 'policy.json');
  const rules = readJson(path.join(abs, 'rules.json'), {});
  const profile = loadProfile(factory.profile, abs);
  // Product-specific ways to run and observe the product (principle 4.6); the builder may run them.
  if (factory.observe) profile.observe = { ...(profile.observe ?? {}), ...factory.observe };
  const unknownGates = factory.gates.order.filter((g) => !KNOWN_GATES.includes(g));
  if (unknownGates.length) throw new FactoryError('CONFIG', `unknown gate(s) in gates.order: ${unknownGates.join(', ')}`);
  if (factory.gates.order.includes('review') && !factory.roles.reviewer) {
    throw new FactoryError('CONFIG', 'gates.order includes review, but no reviewer role is configured: the review would be skipped silently');
  }
  if (factory.agent.adapter === 'command') {
    if (!factory.agent.command?.length) throw new FactoryError('CONFIG', 'the command adapter needs agent.command');
    // A generic CLI never calls the factory's policy hook: nothing confines its tools. Only an explicit policy decision allows that.
    if (!policy.allowUnconfinedAgent) {
      throw new FactoryError('POLICY', 'the generic command adapter cannot enforce the tool policy; the AI policy must set allowUnconfinedAgent: true to use it');
    }
  }
  if (!skipTrifecta) checkTrifecta(factory.roles);
  for (const [name, r] of Object.entries(factory.roles)) {
    const unapproved = r.tools.filter((t) => !policy.approvedTools.includes(t));
    if (unapproved.length) throw new FactoryError('POLICY', `role ${name} uses tools not in the AI policy: ${unapproved.join(', ')}`);
  }
  const knowledge = listFiles(path.join(abs, 'knowledge')).filter((f) => f.endsWith('.md'));
  return {
    controlDir: abs, factory, policy, rules, profile, knowledge,
    digest: configDigest(abs, profile.file),
  };
}

// AI policy checks for a concrete run (principle 8.3).
export function checkModelApproved(config, model) {
  if (!config.policy.approvedModels.includes(model)) {
    throw new FactoryError('POLICY', `model ${model} is not in the AI policy's approved models (${config.policy.approvedModels.join(', ')})`);
  }
}
