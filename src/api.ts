import { httpRequest } from '@socketsecurity/lib/http-request'

export async function getQuota(apiKey: string) {
  const res = await httpRequest('https://api.socket.dev/v0/settings', {
    method: 'POST',
    headers: {
      Authorization: toAuthHeader(apiKey),
      'Content-Type': 'application/json',
    },
  })
  if (res.ok) {
    return res.json()
  } else {
    throw new Error(res.text())
  }
}

/////////
// DESIGN NOTES
/////////
//
// We pass apiKeys rather than shared state to avoid certain races, so if a
// workflow starts with 1 API key it is inconvenient to grab an implicitly
// new api key in the middle of the workflow
//
export function toAuthHeader(apiKey: string) {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64url')}`
}
