'use strict'

/**
 * @typedef SocketYmlV1
 * @property {string[]} [ignore]
 * @property {{ [issueName: string]: boolean }} [issues]
 * @property {boolean} [beta] unused v1 option
 * @property {boolean} [enabled] enable/disable the Socket.dev GitHub app entirely
 * @property {boolean} [projectReportsEnabled] enable/disable Github app project report checks
 * @property {boolean} [pullRequestAlertsEnabled] enable/disable GitHub app pull request alert checks
 */

/** @type {import('ajv').JSONSchemaType<SocketYmlV1>} */
const socketYmlSchemaV1 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    ignore: {
      type: 'array',
      items: { type: 'string' },
      nullable: true,
    },
    issues: {
      type: 'object',
      nullable: true,
      required: [],
      additionalProperties: { type: 'boolean' },
    },
    beta: { type: 'boolean', nullable: true, default: true },
    enabled: { type: 'boolean', nullable: true, default: true },
    projectReportsEnabled: { type: 'boolean', nullable: true, default: true },
    pullRequestAlertsEnabled: { type: 'boolean', nullable: true, default: true },
  },
  minProperties: 1,
  additionalProperties: false,
}

module.exports = {
  socketYmlSchemaV1
}
