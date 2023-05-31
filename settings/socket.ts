
import { filepath } from './file-path'
import { nodeFS } from './node-fs'
import { JSONSettingsFile } from './settings'
const AuthOperatingModes = {
  /**
   * Sends up data anonymously, data may be persisted indefinitely
   */
  OPEN_SOURCE: "OPEN_SOURCE",
  /**
   * Sends up data associated with a login, data may be persisted indefinitely
   */
  LOGIN: "LOGIN",
  /**
   * Prevents actions requiring a login
   */
  DISABLED: "DISABLED",
  /**
   * Need user interaction, probably should prompt
   */
  UNDEFINED: "UNDEFINED",
} as const
type AuthOperatingMode =
  (typeof AuthOperatingModes)[keyof typeof AuthOperatingModes]

type SocketSettings = Partial<{
  operatingMode: AuthOperatingMode
  apiKey: string | null
  locallyActiveEnterpriseOrganizations: Array<string>
}>
type ReadonlySocketSettings = Readonly<Partial<{
  operatingMode: AuthOperatingMode
  apiKey: string | null
  locallyActiveEnterpriseOrganizations: ReadonlyArray<string>
}>>
const settingsFile = new JSONSettingsFile<string, SocketSettings, ReadonlySocketSettings>(filepath, nodeFS)
settingsFile.updateSettings(settings => {
  settings.apiKey = '1'
  console.log({settings})
})
// settingsFile.updateSettings((settings) => {
//   settings.apiKey = '1'
// })
