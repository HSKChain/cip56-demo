import { createApp } from './app.js'
import { CantonClient, HttpCantonTransport } from './canton.js'

const host = '127.0.0.1'
const port = 8787
const client = new CantonClient(new HttpCantonTransport())

createApp(client).listen(port, host, () => {
  console.log(`CIP-56 demo API listening on http://${host}:${port}`)
})
