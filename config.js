// Safe to publish: Supabase publishable keys identify the public browser API;
// row-level security and protected RPCs enforce access. Never add a secret key.
window.QUIZ_PLATFORM_CONFIG = {
  supabaseUrl: "https://jwrtxdmawjmkuvxgpmlq.supabase.co",
  supabasePublishableKey: "sb_publishable_QEIjNfLqSc_bMO0MNjMUXQ_Uc468owl",
  workerOrigin: "https://wild-haze-73b3.matthew-belinkie-3af.workers.dev",
  defaultQuizVersionId: "b7995faa-2fc6-448a-a9ab-43d97cdc1941",
  // A Sentry DSN is public by design. Paste the Browser JavaScript project's
  // client key here to enable external alerts; leave blank to use local logs only.
  sentryDsn: "https://c0f3904900d81a95e13d602256390b94@o4511898592018432.ingest.us.sentry.io/4511898598834176"
};
