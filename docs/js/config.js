/* Fill these in from Supabase -> Project Settings -> API. Both values are meant to be public;
   the database rules (supabase/schema.sql) decide what students and inspectors can do. */
window.BB_CONFIG = {
  SUPABASE_URL: "https://nyvququkfeqqjiwladmx.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_QoGDg0YjMtgXdQwPqgXn2A_YoAyEZ3D",
};
// The Octave engine on each inspector's laptop (app.py / start_windows.bat) talks to this same
// Supabase project directly - see engine_sync.py - so there's no engine URL to configure here.
