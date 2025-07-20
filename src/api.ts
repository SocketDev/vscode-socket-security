/////////
// DESIGN NOTES
/////////
//
// We pass apiKeys rather than shared state to avoid certain races, so if a
// workflow starts with 1 API key it is inconvenient to grab an implicitly
// new api key in the middle of the workflow
//
function toAuthHeader(apiKey: string) {
    return `Basic ${Buffer.from(`${apiKey}:`).toString('base64url')}`
}
export async function getQuota(apiKey: string) {
    const res = await fetch('https://api.socket.dev/v0/settings', {
        method: 'POST',
        headers: {
            Authorization: toAuthHeader(apiKey),
            'Content-Type': 'application/json'
        }
    })
    if (res.ok) {
        return res.json()
    } else {
        throw new Error(await res.text())
    }
}
