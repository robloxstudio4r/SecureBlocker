import { supabase } from './supabase-client.js';

export async function signUp(email, password, fullName) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } }
  });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  await supabase.auth.signOut();
  window.location.href = 'index.html';
}

export async function requireAuth(allowedRoles = null) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = 'index.html';
    return null;
  }
  const role = session.user.app_metadata?.role || 'student';
  if (allowedRoles && !allowedRoles.includes(role)) {
    // Wrong role — send them where they belong
    const home = { student: 'learn.html', teacher: 'teach.html', admin: 'admin.html' }[role] || 'index.html';
    window.location.href = home;
    return null;
  }
  return session;
}

export async function getProfile(userId) {
  const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();
  return data;
}
