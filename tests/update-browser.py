"""V3 user-visible flows. API/Telegram fixtures are isolated; no customer messages."""
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
from content_browser_import import ContentFixture
from browser import TG,ROOT,OUT,BASE_URL

class UpdateFixture(ContentFixture):
 def __init__(self):
  super().__init__();self.joined=False;self.calls=[]
  self.reviews += [dict(id=3,telegram_id=101,product_id=2,author_name='Автор площадки',rating=4,body='Фото покупателя с площадки',source='store',origin_name='Pinduoduo',origin_url='https://example.com/original',status='approved',media=[dict(mime='image/jpeg',url='https://qa-media.local/lamp.jpg')],verified_purchase=False,created_at='2026-10-21T10:00:00Z',product=dict(id=2,name='Худи оверсайз',sku='RM-600001')),dict(id=4,telegram_id=101,product_id=None,author_name='Видео магазина',rating=3,body='Видеообзор товара',source='store',status='approved',media=[dict(mime='video/mp4',url='https://qa-media.local/test.mp4')],verified_purchase=False,created_at='2026-10-21T11:00:00Z')]
  self.docs=[dict(slug='privacy',title='Политика конфиденциальности',body='1. Кто обрабатывает данные\nООО «RAMP». Поддержка: @ramphelper.\n\n2. Какие данные мы храним\nИмя, телефон, адрес доставки и история заказов.\n\n3. Безопасный текст\n<img src=x onerror="window.qaXss=1">',published=True,version=1,updated_at='2026-10-21T12:00:00Z'),dict(slug='offer',title='Публичная оферта',body='1. Исполнитель\nООО «RAMP». {{почтовый адрес}}. SECRET-DRAFT',published=False,version=1,updated_at='2026-10-21T12:00:00Z')]
 def route(self,route):
  req=route.request
  if req.method=='OPTIONS' or '/functions/v1/' not in req.url:return super().route(route)
  b=req.post_data_json or {};a=b.get('action');admin='/admin' in req.url;self.calls.append(b)
  if a=='checkSubscription':
   self.profile['subscription_verified']=self.joined;d=dict(subscribed=self.joined,profile=self.profile)
  elif a=='legal':d=dict(document=next((x for x in self.docs if x['slug']==b['slug'] and x['published']),None))
  elif a=='documents':d=dict(documents=self.docs)
  elif a=='saveDocument':
   row=next(x for x in self.docs if x['slug']==b['slug']);assert row['version']==b['version'];row.update({k:b[k] for k in ['title','body','published']});row['version']+=1;d=dict(document=row)
  elif a=='reviews' and not admin:
   base=[r for r in self.reviews if r['status']=='approved' and (not b.get('product_id') or r['product_id']==b['product_id'])]
   source=b.get('source_filter','all')
   if source=='marketplace':base=[r for r in base if r.get('origin_name')]
   elif source=='customer':base=[r for r in base if r['source']=='customer']
   elif source=='store':base=[r for r in base if r['source']=='store' and not r.get('origin_name')]
   dist={str(n):sum(r['rating']==n for r in base) for n in range(1,6)};rows=base
   if b.get('rating'):rows=[r for r in rows if r['rating']==b['rating']]
   media=b.get('media_filter','all')
   if media!='all':rows=[r for r in rows if any(m['mime'].startswith('image/' if media=='photo' else 'video/') for m in r['media'])]
   d=dict(reviews=rows,mine=None,stats=dict(count=len(base),rating=round(sum(r['rating'] for r in base)/len(base),1) if base else 0,distribution=dist),has_more=False)
  else:return super().route(route)
  route.fulfill(json=d,headers={'Access-Control-Allow-Origin':'*'})

def wire(c,f,telegram=TG):
 c.route('https://telegram.org/**',lambda r:r.fulfill(body=telegram,content_type='application/javascript'));c.route('https://*.supabase.co/**',f.route)
 c.route('https://qa-media.local/**',lambda r:r.fulfill(path=str(ROOT/'img/lamp.jpg'),content_type='image/jpeg'))

def main():
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,args=['--no-sandbox']);c=browser.new_context(viewport=dict(width=390,height=844),color_scheme='dark');f=UpdateFixture();wire(c,f,TG.replace("colorScheme:'light'","colorScheme:'dark'"))
  page=c.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.goto(BASE_URL,wait_until='networkidle')
  assert page.evaluate("getComputedStyle(document.body).backgroundColor")=='rgb(255, 255, 255)';assert page.locator('html').get_attribute('data-theme')=='light'
  page.screenshot(path=str(OUT/'v3-home.png'),animations='disabled')
  page.locator('.tab[data-tab="profile"]').click();page.locator('[data-open-reviews]').click();expect(page.locator('.rating-number')).to_have_text('4.0');expect(page.locator('#reviewFeedRows .review-card')).to_have_count(3)
  page.screenshot(path=str(OUT/'v3-reviews.png'),animations='disabled')
  page.locator('[data-review-filter="media_filter"][data-filter-value="photo"]').click();expect(page.locator('#reviewFeedRows .review-card')).to_have_count(1);expect(page.locator('#reviewFeedRows .review-source')).to_contain_text('Pinduoduo')
  page.locator('#reviewSourceFilter').select_option('marketplace');expect(page.locator('.rating-number')).to_have_text('4.0');page.locator('[data-review-filter="rating"][data-filter-value="5"]').click();expect(page.locator('#reviewFeedRows')).to_contain_text('Нет отзывов с такими фильтрами')
  page.locator('[data-review-filter="rating"][data-filter-value=""]').click();page.locator('#reviewSourceFilter').select_option('store');page.locator('[data-review-filter="media_filter"][data-filter-value="video"]').click();expect(page.locator('#reviewFeedRows')).to_contain_text('Видео магазина')
  for w in [320,390,780]:
   page.set_viewport_size(dict(width=w,height=844));assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
  page.locator('#infoSheet [data-close-sheet]').click();page.set_viewport_size(dict(width=390,height=844));page.locator('[data-legal="privacy"]').first.click();expect(page.locator('.legal-copy h3')).to_have_count(3);expect(page.locator('.legal-copy')).to_contain_text('<img src=x');assert page.evaluate('window.qaXss') is None
  page.screenshot(path=str(OUT/'v3-privacy.png'),animations='disabled');page.locator('#infoSheet [data-close-sheet]').click()
  page.goto(BASE_URL+'/admin.html',wait_until='networkidle');page.locator('.tab[data-tab="content"]').click();page.locator('[data-content-mode="documents"]').click();expect(page.locator('#contentList')).to_contain_text('Документы ООО «RAMP»');page.screenshot(path=str(OUT/'v3-admin-documents.png'),animations='disabled')
  page.locator('[data-edit-document="offer"]').click();page.locator('#documentBody').fill('1. Исполнитель\nООО «RAMP». Тестовые реквизиты.\n\n2. Оплата\nВ сумах.');page.locator('[data-document-preview]').click();expect(page.locator('#documentPreview h3')).to_have_count(2);page.locator('#documentPublished').check();page.locator('[data-save-document]').click();expect(page.locator('#sheet')).not_to_have_class('sheet open');assert next(x for x in f.docs if x['slug']=='offer')['published']
  page.locator('[data-content-mode="reviews"]').click();page.locator('#addContent').click();page.locator('#storeReviewOrigin').fill('Pinduoduo');page.locator('#storeReviewOriginUrl').fill('https://example.com/original');page.locator('#storeReviewAuthor').fill('Автор площадки');page.locator('#storeReviewBody').fill('Перенесённый отзыв');page.locator('[data-save-store-review]').click();expect(page.locator('#sheet')).not_to_have_class('sheet open');assert f.saved_review['origin_name']=='Pinduoduo'
  c.close()
  gate=browser.new_context(viewport=dict(width=390,height=844));g=UpdateFixture();g.profile.update(subscription_verified=False,phone_verified=False,tg_phone=None);wire(gate,g);pg=gate.new_page();pg.on('pageerror',lambda e:errors.append(str(e)));pg.goto(BASE_URL,wait_until='networkidle');expect(pg.locator('#gateTitle')).to_have_text('Подпишитесь на наш канал');assert not any(x['action']=='orders' for x in g.calls)
  pg.screenshot(path=str(OUT/'v3-registration.png'),animations='disabled');pg.locator('#gate [data-legal="privacy"]').click();expect(pg.locator('#infoSheet')).to_have_class('sheet open');assert pg.evaluate("getComputedStyle(document.querySelector('#infoSheet')).zIndex")=='90';pg.locator('#infoSheet [data-close-sheet]').click();expect(pg.locator('#gate')).to_have_class('gate show')
  pg.locator('#gateBtn').click();expect(pg.locator('#gateTitle')).to_have_text('Подпишитесь на наш канал');g.joined=True;pg.locator('#gateBtn').click();expect(pg.locator('#gateTitle')).to_contain_text('номер Узбекистана');expect(pg.locator('#gateSteps')).to_contain_text('шаг 2');gate.close()
  public=browser.new_context(viewport=dict(width=390,height=844));q=UpdateFixture();wire(public,q,'window.Telegram={WebApp:{ready(){},expand(){},BackButton:{show(){},hide(){},onClick(){}}}};');pg=public.new_page();pg.goto(BASE_URL+'/?document=offer',wait_until='networkidle');expect(pg.locator('#infoBody')).to_contain_text('Документ готовится');expect(pg.locator('#infoBody')).not_to_contain_text('SECRET-DRAFT');assert not any(x['action']=='me' for x in q.calls);public.close();browser.close();assert not errors,errors
  print('PASS: white theme in dark Telegram, review histogram/filters/source, legal rendering/XSS/draft privacy, admin documents/source editor, subscription gate and public documents')
if __name__=='__main__':main()
