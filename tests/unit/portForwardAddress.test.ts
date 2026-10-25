import { describe, expect, it } from 'vitest'
import {
  canonicalizeIpLiteral,
  formatIpv6Bytes,
  isIpLiteral,
  isLoopbackAddress,
} from '@shared/portForward/address'

describe('port forward address helpers', () => {
  it('canonicalizes IPv4 and bracketed IPv6 literals', () => {
    expect(canonicalizeIpLiteral('127.0.0.1')).toBe('127.0.0.1')
    expect(canonicalizeIpLiteral(' 127.000.000.001 ')).toBe('127.0.0.1')
    expect(canonicalizeIpLiteral('[::1]')).toBe('::1')
    expect(canonicalizeIpLiteral('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1')
    expect(canonicalizeIpLiteral('::')).toBe('::')
    expect(canonicalizeIpLiteral('0.0.0.0')).toBe('0.0.0.0')
  })

  it('rejects hostnames, malformed literals and out-of-range octets', () => {
    for (const value of [
      '',
      'localhost',
      'example.com',
      '256.0.0.1',
      '1.2.3',
      '1.2.3.4.5',
      '1:2:3:4:5:6:7:8:9',
      '[::1',
      '::1]',
      'fe80::1%eth0',
      '127.0.0.1:22',
    ]) {
      expect(canonicalizeIpLiteral(value)).toBeNull()
      expect(isIpLiteral(value)).toBe(false)
    }
  })

  it('only treats 127.0.0.0/8 and ::1 as loopback', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.255.1.9')).toBe(true)
    expect(isLoopbackAddress('[::1]')).toBe(true)
    expect(isLoopbackAddress('0.0.0.0')).toBe(false)
    expect(isLoopbackAddress('10.0.0.1')).toBe(false)
    expect(isLoopbackAddress('::')).toBe(false)
    expect(isLoopbackAddress('localhost')).toBe(false)
  })

  it('formats exactly 16 IPv6 bytes without a leading zero run', () => {
    const bytes = new Uint8Array(16)
    bytes.set([0x20, 0x01, 0x0d, 0xb8])
    bytes[15] = 1
    expect(formatIpv6Bytes(bytes)).toBe('2001:db8::1')
    expect(formatIpv6Bytes(new Uint8Array(16))).toBe('::')
    expect(() => formatIpv6Bytes(new Uint8Array(15))).toThrow(/16 bytes/)
  })
})
