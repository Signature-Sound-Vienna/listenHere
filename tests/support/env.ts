/**
 * Typed access to test environment variables.
 * All values fall back to safe defaults so tests can run locally
 * without a fully configured .env file (Solid tests excepted).
 */

export const env = {
  baseUrl: process.env.APP_BASE_URL ?? 'http://localhost:5001',

  remoteAlignmentUrl: process.env.REMOTE_ALIGNMENT_URL ?? '',  // used with ?align= parameter
  remoteAudioBaseUrl: process.env.REMOTE_AUDIO_BASE_URL ?? '',

  solidPodUrl:              process.env.SOLID_POD_URL ?? '',
  solidWebId:               process.env.SOLID_WEBID ?? '',
  solidClientId:            process.env.SOLID_CLIENT_ID ?? '',
  solidClientSecret:        process.env.SOLID_CLIENT_SECRET ?? '',
  solidAnnotationContainer: process.env.SOLID_ANNOTATION_CONTAINER ?? '',
  solidSelectionContainer:  process.env.SOLID_SELECTION_CONTAINER ?? '',
  solidAudioUriPrefix:      process.env.SOLID_AUDIO_URI_PREFIX ?? '',

  localAudioServerUrl: process.env.LOCAL_AUDIO_SERVER_URL ?? 'http://localhost:8080',

  /** True when all Solid env vars are configured. */
  get solidConfigured(): boolean {
    return !!(this.solidPodUrl && this.solidClientId && this.solidClientSecret);
  },
};
