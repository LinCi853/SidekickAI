'use strict'

// One identity rule shared by application assembly, cloud build configuration and every
// workspace that reads the same key sets: 8-80 characters, lowercase letters, digits,
// underscores and hyphens, with an alphanumeric first and last character. The 80-character
// ceiling keeps the 75-character self-built-<sha256> identities valid, while uppercase letters
// and dots are no longer accepted.
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{6,78}[a-z0-9]$/
const KEY_ID_MESSAGE = 'keyId 必须 8–80 位、小写字母或数字开头结尾，内部可含 `_` 或 `-`'

function isKeyId(value) {
  return typeof value === 'string' && KEY_ID_PATTERN.test(value)
}

module.exports = { KEY_ID_PATTERN, KEY_ID_MESSAGE, isKeyId }
