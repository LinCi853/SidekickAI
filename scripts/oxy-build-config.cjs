const fs = require('node:fs');
const path = require('node:path');
const { localBuildEnvironment } = require('./local-build-config.cjs');

const CONFIG = path.resolve(__dirname, '../resources/oxy-deployment.json');

function cloudBuildEnvironment(env = process.env, file = CONFIG) {
  env = localBuildEnvironment(path.resolve(path.dirname(file), '..'), env);
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const origin = env.SIDEKICK_OXY_ORIGIN ?? config.origin ?? '';
  const keys = JSON.parse(env.SIDEKICK_RESOURCE_TRUST_KEYS_JSON ?? JSON.stringify(config.resourceKeys ?? []));
  const hosts = JSON.parse(env.SIDEKICK_RESOURCE_ALLOWED_HOSTS_JSON ?? JSON.stringify(config.allowedHosts ?? []));
  const distributionKeys = JSON.parse(env.SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON
    ?? JSON.stringify(config.distributionKeys ?? config.adminKeys ?? config.resourceKeys ?? []));
  if (origin) {
    const url = new URL(origin);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Invalid Oxy build origin.');
  }
  if (!Array.isArray(keys) || keys.length > 16 || keys.some(key => !key || !/^[A-Za-z0-9_-]{8,80}$/.test(key.id)
    || key.publicKey?.kty !== 'OKP' || key.publicKey?.crv !== 'Ed25519' || !/^[A-Za-z0-9_-]{43}$/.test(key.publicKey?.x ?? '')
    || key.publicKey?.d !== undefined || key.privateKey !== undefined)) throw new Error('Only public resource trust may enter a build.');
  if (!Array.isArray(hosts) || hosts.some(host => typeof host !== 'string' || !/^[a-z0-9.-]+$/.test(host))) throw new Error('Invalid approved resource hosts.');
  if (!Array.isArray(distributionKeys) || distributionKeys.length > 16 || distributionKeys.some(key => !key
    || !/^[A-Za-z0-9_-]{8,80}$/.test(key.id) || key.publicKey?.kty !== 'OKP' || key.publicKey?.crv !== 'Ed25519'
    || !/^[A-Za-z0-9_-]{43}$/.test(key.publicKey?.x ?? '') || key.publicKey?.d !== undefined || key.privateKey !== undefined)) {
    throw new Error('Only public application distribution trust may enter a build.');
  }
  return { SIDEKICK_OXY_ORIGIN: origin, SIDEKICK_RESOURCE_TRUST_KEYS_JSON: JSON.stringify(keys),
    SIDEKICK_RESOURCE_ALLOWED_HOSTS_JSON: JSON.stringify(hosts), SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON: JSON.stringify(distributionKeys) };
}

module.exports = { cloudBuildEnvironment, configPath: CONFIG };
