'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { cloudBuildEnvironment } = require('./oxy-build-config.cjs')

test('concept builds accept explicit private IPv4 and retain public HTTP restrictions', () => {
  for (const origin of ['http://192.168.31.180:4318', 'http://10.0.0.1', 'http://172.16.0.1',
    'http://127.0.0.1:4318', 'https://service.example']) {
    assert.equal(cloudBuildEnvironment({ SIDEKICK_OXY_ORIGIN: origin }).SIDEKICK_OXY_ORIGIN, origin)
  }
  for (const origin of ['http://8.8.8.8', 'http://169.254.1.1', 'http://172.32.0.1', 'http://oxy.lan',
    'http://192.168.031.180', 'http://3232243636', 'http://192.168.31.180:0',
    'http://user@192.168.31.180', 'http://192.168.31.180/api', 'http://192.168.31.180?x=1']) {
    assert.throws(() => cloudBuildEnvironment({ SIDEKICK_OXY_ORIGIN: origin }), origin)
  }
})
