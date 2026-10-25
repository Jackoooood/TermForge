function parseIpv4(value: string): number[] | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    octets.push(octet)
  }
  return octets
}

function parseIpv6(value: string): number[] | null {
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0 || !/^[0-9a-f:.]+$/.test(normalized)) return null

  const halves = normalized.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if (halves.length === 1 && right.length > 0) return null

  const groups = [...left, ...right]
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null

  const missing = 8 - groups.length
  if (halves.length === 1) {
    if (missing !== 0) return null
    return groups.map((group) => Number.parseInt(group, 16))
  }
  if (missing < 1) return null
  return [
    ...left.map((group) => Number.parseInt(group, 16)),
    ...Array<number>(missing).fill(0),
    ...right.map((group) => Number.parseInt(group, 16)),
  ]
}

function formatIpv6Groups(groups: number[]): string {
  let bestStart = -1
  let bestLength = 0
  for (let index = 0; index < groups.length; index += 1) {
    if (groups[index] !== 0) continue
    let end = index
    while (end < groups.length && groups[end] === 0) end += 1
    const length = end - index
    if (length >= 2 && length > bestLength) {
      bestStart = index
      bestLength = length
    }
    index = end - 1
  }

  const hex = groups.map((group) => group.toString(16))
  if (bestStart === -1) return hex.join(':')

  const left = hex.slice(0, bestStart).join(':')
  const right = hex.slice(bestStart + bestLength).join(':')
  return `${left}::${right}`
}

export function canonicalizeIpLiteral(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const unbracketed =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed

  const ipv4 = parseIpv4(unbracketed)
  if (ipv4) return ipv4.join('.')

  const ipv6 = parseIpv6(unbracketed)
  if (ipv6) return formatIpv6Groups(ipv6)

  return null
}

export function isIpLiteral(value: string): boolean {
  return canonicalizeIpLiteral(value) !== null
}

export function isLoopbackAddress(value: string): boolean {
  const canonical = canonicalizeIpLiteral(value)
  if (!canonical) return false
  if (canonical === '::1') return true
  return canonical.split('.')[0] === '127'
}

export function formatIpv6Bytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new Error('IPv6 address must contain exactly 16 bytes')
  }
  const groups: number[] = []
  for (let index = 0; index < bytes.length; index += 2) {
    groups.push(((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0))
  }
  return formatIpv6Groups(groups)
}
