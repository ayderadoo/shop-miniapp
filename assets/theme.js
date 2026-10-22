(() => {
  const key='ramp:theme';
  const read=()=>{try{return localStorage.getItem(key);}catch{return null;}};
  let selected=read() || 'light';
  function apply() {
    const dark=selected==='dark';
    document.documentElement.dataset.theme=dark?'dark':'light';
    const bg=dark?'#0B1424':'#FFFFFF';
    const tg=window.Telegram?.WebApp;
    try{tg?.setHeaderColor?.(bg);tg?.setBackgroundColor?.(bg);tg?.setBottomBarColor?.(bg);}catch{}
    document.querySelectorAll('[data-theme-choice]').forEach(b=>{const on=b.dataset.themeChoice===selected;b.classList.toggle('on',on);b.setAttribute('aria-pressed',String(on));});
    document.querySelectorAll('[data-theme-toggle]').forEach(b=>{b.setAttribute('aria-label',dark?'Включить светлую тему':'Включить тёмную тему');b.setAttribute('aria-pressed',String(dark));b.innerHTML=dark?'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/></svg>':'<svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>';});
  }
  function set(value){selected=value==='dark'?'dark':'light';try{localStorage.setItem(key,selected);}catch{}apply();}
  document.addEventListener('click',e=>{const t=e.target.closest('[data-theme-toggle]'),b=e.target.closest('[data-theme-choice]');if(t)set(selected==='dark'?'light':'dark');if(b)set(b.dataset.themeChoice);});
  document.addEventListener('DOMContentLoaded',apply);
  window.addEventListener('storage',e=>{if(e.key===key){selected=e.newValue==='dark'?'dark':'light';apply();}});
  window.RampTheme={apply,set,get value(){return selected;}};
  apply();
})();
