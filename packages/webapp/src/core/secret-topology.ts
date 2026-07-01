/**
 * Back-compat re-export. The topology resolver was generalized into
 * `float-topology.ts` so the lick legs and the secrets leg share one
 * extension discriminator. Existing secret-CRUD call sites and tests keep
 * importing `resolveSecretTopology` / `SecretTopology` from here unchanged.
 */
export {
  type FloatTopology as SecretTopology,
  resolveFloatTopology as resolveSecretTopology,
} from './float-topology.js';
