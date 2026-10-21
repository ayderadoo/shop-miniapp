(() => {
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function media(items=[],cls='content-media') {
    return `<div class="${cls}">${items.filter(m=>/^https:\/\//.test(m.url || '')).map(m=>m.mime?.startsWith('video/')
      ? `<div class="video-wrap"><video controls playsinline preload="metadata" src="${esc(m.url)}"></video><a href="${esc(m.url)}" target="_blank" rel="noopener">Открыть видео →</a></div>`
      : `<a href="${esc(m.url)}" target="_blank" rel="noopener"><img src="${esc(m.url)}" alt="Фото к публикации" loading="lazy" decoding="async"></a>`).join('')}</div>`;
  }
  const stars=n=>'★'.repeat(Number(n)||0)+'☆'.repeat(5-(Number(n)||0));
  function review(row) {
    const external=row.source==='store' && row.origin_name;
    const source=external?`Отзыв с ${esc(row.origin_name)} · размещён магазином`:row.source==='store'?'Опубликовано магазином':row.verified_purchase?'Покупка в RAMP подтверждена':'Покупатель RAMP';
    const tag=external && /^https:\/\/[^\s]+$/.test(row.origin_url || '')?`<a class="review-source" href="${esc(row.origin_url)}" target="_blank" rel="noopener noreferrer">${source} →</a>`:`<span class="review-source">${source}</span>`;
    return `<article class="review-card"><div class="review-top"><b>${esc(row.author_name)}</b><span class="review-stars" aria-label="Оценка ${row.rating} из 5">${stars(row.rating)}</span></div><div class="muted">${new Date(row.created_at).toLocaleDateString('ru-RU')}</div>${tag}<p class="body-copy">${esc(row.body)}</p>${media(row.media)}${row.product?`<button class="review-product" data-review-product="${Number(row.product.id)||Number(row.product_id)}">${esc(row.product.name)}${row.product.sku?' · '+esc(row.product.sku):''} →</button>`:''}</article>`;
  }
  function legal(body='') {
    return `<div class="legal-copy">${String(body).split(/\n\s*\n/).map(block=>{const lines=block.trim().split('\n');return /^\d+[.)]\s/.test(lines[0])?`<h3>${esc(lines.shift())}</h3><p>${esc(lines.join('\n'))}</p>`:`<p>${esc(block)}</p>`;}).join('')}</div>`;
  }
  const picker=(id='contentFiles')=>`<label for="${id}">Фото / видео (необязательно)</label><input id="${id}" type="file" accept="image/*,video/mp4,video/quicktime,video/webm" multiple><div class="muted">До 5 файлов: фото до 5 МБ, видео MP4/MOV/WebM до 25 МБ.</div>`;
  const keep=(items=[])=>items.length?`<div class="keep-media">${items.map(m=>`<label><input type="checkbox" data-keep-upload value="${esc(m.upload_id)}" checked> Оставить ${m.mime?.startsWith('video/')?'видео':'фото'}</label>`).join('')}${media(items)}</div>`:'';
  async function upload(input,api,scope,compress,onProgress=()=>{}) {
    const files=[...input.files];
    if(files.length>5)throw new Error('Можно приложить до 5 файлов');
    const key=files.map(f=>f.name+f.size+f.lastModified).join('|');
    if(input._uploadKey!==key){input._uploadKey=key;input._uploaded=[];}
    const ids=input._uploaded;
    for(let i=ids.length;i<files.length;i++) {
      let file=files[i],mime=file.type;
      onProgress(`Загружаем файл ${i+1} из ${files.length}…`);
      if(mime.startsWith('image/')) {
        if(file.size>20*1024*1024)throw new Error('Исходное фото больше 20 МБ');
        file=await (await fetch(await compress(file))).blob();mime='image/jpeg';
      } else if(!mime) mime=/\.mov$/i.test(file.name)?'video/quicktime':/\.mp4$/i.test(file.name)?'video/mp4':/\.webm$/i.test(file.name)?'video/webm':'';
      if(!['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime'].includes(mime))throw new Error('Выберите фото или видео MP4, MOV, WebM');
      if(file.size>(mime.startsWith('image/')?5:25)*1024*1024)throw new Error('Фото — до 5 МБ, видео — до 25 МБ');
      const signed=await api('createMediaUpload',{scope,mime,size:file.size});
      const response=await fetch(signed.signed_url,{method:'PUT',headers:{'Content-Type':mime,'x-upsert':'false'},body:file});
      if(!response.ok)throw new Error('Не удалось загрузить файл. Проверьте соединение и повторите');
      ids.push(signed.upload_id);
    }
    return [...ids];
  }
  window.RampContent={esc,media,review,stars,picker,keep,upload,legal};
})();
