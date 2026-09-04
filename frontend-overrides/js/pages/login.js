// Extracted from login.html so the page is clean under the enforced CSP
// (script-src 'self'): no inline <script>, no nonce placeholder.
(async () => {
  // Load version
  try {
    const vr = await fetch('/api/version');
    if (vr.ok) {
      const vd = await vr.json();
      document.getElementById('version-label').textContent = 'v' + vd.version;
    }
  } catch(e) {}

  // Prefill last username
  const usernameInput = document.getElementById('username');
  const savedUser = localStorage.getItem('odysseus-last-user');
  if (savedUser && usernameInput) {
    usernameInput.value = savedUser;
    document.getElementById('password').focus();
  }

  const form = document.getElementById('authForm');
  const errEl = document.getElementById('error');
  const setupNote = document.getElementById('setupNote');
  const confirmGroup = document.getElementById('confirmGroup');
  const submitBtn = document.getElementById('submitBtn');
  const toggleArea = document.getElementById('toggleArea');
  const toggleLink = document.getElementById('toggleLink');
  const toggleText = document.getElementById('toggleText');

  let mode = 'login'; // 'login' | 'signup' | 'setup'
  let signupAllowed = false;

  const rememberToggle = document.getElementById('rememberToggle');

  function setMode(m) {
    mode = m;
    errEl.style.display = 'none';
    if (m === 'setup') {
      setupNote.textContent = 'First-time setup — create your admin account';
      setupNote.style.display = 'block';
      confirmGroup.style.display = 'block';
      submitBtn.textContent = 'Create Admin Account';
      toggleArea.style.display = 'none';
      rememberToggle.style.display = 'none';
    } else if (m === 'signup') {
      setupNote.style.display = 'none';
      confirmGroup.style.display = 'block';
      submitBtn.innerHTML = '<span style="position:relative;top:1px;">Create Account</span>';
      toggleArea.style.display = 'block';
      toggleText.textContent = 'Already have an account? ';
      toggleLink.textContent = 'Sign in';
      rememberToggle.style.display = 'none';
    } else {
      setupNote.style.display = 'none';
      confirmGroup.style.display = 'none';
      submitBtn.textContent = 'Sign In';
      toggleArea.style.display = signupAllowed ? 'block' : 'none';
      toggleText.textContent = "Don't have an account? ";
      toggleLink.textContent = 'Sign up';
      rememberToggle.style.display = '';
    }
  }

  // Check auth status
  try {
    const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
    const data = await res.json();
    if (data.authenticated) {
      window.location.replace('/');
      return;
    }
    signupAllowed = !!data.signup_enabled;
    if (!data.configured) {
      setMode('setup');
    } else {
      setMode('login');
    }
  } catch (e) {
    setMode('login');
  }

  toggleLink.addEventListener('click', (e) => {
    e.preventDefault();
    setMode(mode === 'login' ? 'signup' : 'login');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.style.display = 'none';
    submitBtn.disabled = true;

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    // If in TOTP mode, handle the code submission directly
    if (form._totpMode) {
      const totpInput = document.getElementById('totp-input');
      const code = totpInput ? totpInput.value.trim() : '';
      if (!code) { totpInput.focus(); submitBtn.disabled = false; return; }
      const remember = document.getElementById('remember').checked;
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ username, password, remember, totp_code: code })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Invalid code');
        if (!data.ok) throw new Error('Login failed');
        form._totpMode = false;
        finishLogin();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
        submitBtn.disabled = false;
      }
      return;
    }

    // Validate confirm password for setup/signup
    if (mode === 'setup' || mode === 'signup') {
      const confirm = document.getElementById('confirmPassword').value;
      if (password !== confirm) {
        errEl.textContent = 'Passwords do not match';
        errEl.style.display = 'block';
        submitBtn.disabled = false;
        return;
      }
      if (password.length < 8) {
        errEl.textContent = 'Password must be at least 8 characters';
        errEl.style.display = 'block';
        submitBtn.disabled = false;
        return;
      }
    }

    // Setup or signup first
    if (mode === 'setup' || mode === 'signup') {
      const endpoint = mode === 'setup' ? '/api/auth/setup' : '/api/auth/signup';
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Account creation failed');
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
        submitBtn.disabled = false;
        return;
      }
    }

    // Login (auto-login after setup/signup too)
    const remember = document.getElementById('remember').checked;
    function finishLogin() {
      const _rem = document.getElementById('remember').checked;
      if (_rem) localStorage.setItem('odysseus-last-user', username);
      else localStorage.removeItem('odysseus-last-user');
      sessionStorage.removeItem('ody-session-active');
      submitBtn.innerHTML = '<span class="login-spinner" aria-hidden="true"></span>';
      submitBtn.disabled = true;
      Promise.all([
        fetch('/api/sessions', { credentials: 'same-origin' }).then(r => r.json()),
        fetch('/api/auth/features', { credentials: 'same-origin' }).then(r => r.json()),
        fetch('/api/auth/settings', { credentials: 'same-origin' }).then(r => r.json()),
      ]).then(([sess, feat, sett]) => {
        sessionStorage.setItem('ody-prefetch-sessions', JSON.stringify(sess));
        sessionStorage.setItem('ody-prefetch-features', JSON.stringify(feat));
        sessionStorage.setItem('ody-prefetch-settings', JSON.stringify(sett));
      }).catch(() => {}).finally(() => { window.location.replace('/'); });
    }
    async function doLogin(totpCode) {
      const loginBody = { username, password, remember };
      if (totpCode) loginBody.totp_code = totpCode;
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(loginBody)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Login failed');
      return data;
    }
    try {
      let data = await doLogin();
      // 2FA required — show TOTP input
      if (data.requires_totp) {
        submitBtn.disabled = false;
        // Only add TOTP input once
        if (document.getElementById('totp-input')) return;
        form._totpMode = true;
        const totpWrap = document.createElement('div');
        totpWrap.style.cssText = 'margin-top:12px;';
        totpWrap.innerHTML = '<label style="font-size:0.85em;opacity:0.7;display:block;margin-bottom:4px;">2FA Code</label><input type="text" id="totp-input" placeholder="Enter 6-digit code" autocomplete="one-time-code" inputmode="numeric" maxlength="8" style="width:100%;padding:10px 12px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:8px;font-size:14px;box-sizing:border-box;text-align:center;letter-spacing:4px;">';
        const formEl = submitBtn.parentElement;
        formEl.insertBefore(totpWrap, submitBtn);
        const totpInput = document.getElementById('totp-input');
        totpInput.focus();
        submitBtn.textContent = 'Verify';
        return;
      }
      finishLogin();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      submitBtn.disabled = false;
      return;
    }
  });

  // Password show/hide toggles
  const eyeOpen = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const eyeClosed = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><line x1="8" y1="16" x2="16" y2="8"/><line x1="8" y1="8" x2="16" y2="16"/></svg>';

  function wireToggle(btnId, inputId) {
    const btn = document.getElementById(btnId);
    const inp = document.getElementById(inputId);
    if (!btn || !inp) return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.innerHTML = show ? eyeOpen : eyeClosed;
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      inp.focus();
    });
  }
  wireToggle('pwToggle', 'password');
  wireToggle('pwToggleConfirm', 'confirmPassword');
})();

// Prevent login button and eye toggles from stealing focus on mobile (keeps keyboard open)
document.querySelectorAll('#submitBtn, .pw-toggle').forEach(btn => {
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); }, { passive: false });
  btn.addEventListener('touchend', (e) => {
    e.preventDefault();
    btn.click();
  });
});

// Mobile keyboard: shift card up when virtual keyboard opens
if (window.visualViewport) {
  const card = document.querySelector('.card');
  window.visualViewport.addEventListener('resize', () => {
    const vvh = window.visualViewport.height;
    const wh = window.innerHeight;
    if (vvh < wh * 0.8) {
      document.body.style.paddingTop = '5vh';
      // Keep the active input visible without jumping the whole card to the top
      if (document.activeElement && document.activeElement.tagName === 'INPUT') {
        document.activeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } else {
      document.body.style.paddingTop = '';
    }
  });
}
