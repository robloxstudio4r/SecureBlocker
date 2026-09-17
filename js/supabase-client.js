import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export const SUPABASE_URL = 'https://jugchkslfhbonamrxitl.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_YbcxmROCA7EYsYScO6UvHQ_lP8eDAQi';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
