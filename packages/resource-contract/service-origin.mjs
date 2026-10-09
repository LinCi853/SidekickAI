export function isPrivateIpv4(hostname) {
  if (typeof hostname !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  const parts = hostname.split('.').map(Number);
  if (parts.some(value => value > 255) || parts.join('.') !== hostname) return false;
  return parts[0] === 10 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
    || parts[0] === 192 && parts[1] === 168;
}

export function validateServiceOrigin(value) {
  if (value === '') return '';
  if (typeof value !== 'string') throw new Error('Invalid service origin.');
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const lan = isPrivateIpv4(url.hostname) && /^http:\/\/\d+\.\d+\.\d+\.\d+(?::\d+)?\/?$/.test(value)
    && value.slice(7).split(/[/:]/)[0] === url.hostname && url.port !== '0';
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || lan)))) {
    throw new Error('The service requires HTTPS, loopback HTTP or an explicitly configured private IPv4 HTTP origin.');
  }
  return url.origin;
}
