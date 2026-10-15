// T031–T034: further adapters share the T029 registry tables. The provider and mapping lists are
// widened once here; adapter-specific data lives in later migrations.
export const connectorsMigration = {
  version: 15,
  sql: `
ALTER TABLE integration_connections DROP CONSTRAINT integration_connections_provider_check;
ALTER TABLE integration_connections ADD CONSTRAINT integration_connections_provider_check CHECK(provider IN ('moysklad','bitrix24','onec','telegram','kaspi'));
ALTER TABLE integration_mappings DROP CONSTRAINT integration_mappings_entity_type_check;
ALTER TABLE integration_mappings ADD CONSTRAINT integration_mappings_entity_type_check CHECK(entity_type IN ('product','store','counterparty','contact','partner','order','chat'));
`,
};
