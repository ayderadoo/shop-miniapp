"""V4: real browser behavior with controllable latency/failure and real short video."""
from datetime import datetime,timedelta,timezone
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
from content_browser_import import ContentFixture
from browser import TG,ROOT,OUT,BASE_URL

def iso(dt):return dt.isoformat().replace('+00:00','Z')
class ExperienceFixture(ContentFixture):
 def __init__(self):
  super().__init__();self.wish=[];self.pending=[];self.saved_stories=[]
  now=datetime.now(timezone.utc)
  self.stories=[dict(id=1,title='Новый дроп',body='Свежие модели уже в каталоге.',media=[dict(mime='image/jpeg',url='https://qa-media.local/lamp.jpg'),dict(mime='video/mp4',url='https://qa-media.local/story.mp4')],published=True,duration_hours=24,published_at=iso(now),expires_at=iso(now+timedelta(hours=24)),created_at=iso(now),updated_at=iso(now)),dict(id=2,title='Доставка RAMP',body='Следите за заказами по личному ID.',media=[dict(mime='image/jpeg',url='https://qa-media.local/headphones.jpg')],published=True,duration_hours=None,expires_at=None,created_at=iso(now),updated_at=iso(now))]
 def route(self,route):
  req=route.request
  if req.method=='OPTIONS' or '/functions/v1/' not in req.url:return super().route(route)
  b=req.post_data_json or {};a=b.get('action');admin='/admin' in req.url
  if a=='me':
   from browser import PROMO
   return route.fulfill(json=dict(profile=self.profile,cart=self.cart,wish=self.wish,promo=PROMO,payments={'card':'Карта'},is_admin=True,support='ramphelper'),headers={'Access-Control-Allow-Origin':'*'})
  if a=='wishSet':self.pending.append((route,b));return
  if a=='stories':
   rows=self.stories if admin else [r for r in self.stories if r['published'] and (not r.get('expires_at') or r['expires_at']>iso(datetime.now(timezone.utc)))]
   if admin and b.get('filter')=='expired':rows=[r for r in rows if r.get('expires_at') and r['expires_at']<=iso(datetime.now(timezone.utc))]
   start=b.get('offset',0);d=dict(stories=rows if admin else rows[start:start+1],server_time=iso(datetime.now(timezone.utc)),has_more=False if admin else start+1<len(rows))
  elif a=='saveStory':
   self.saved_stories.append(b);now=datetime.now(timezone.utc)
   row=dict(b,id=b.get('id') or len(self.stories)+1,media=self.media(b['media']),created_at=iso(now),updated_at=iso(now),expires_at=iso(now+timedelta(hours=b['duration_hours'])) if b['duration_hours'] else None)
   self.stories=[r for r in self.stories if r['id']!=row['id']]+[row];d=dict(story=row)
  elif a=='deleteStory':self.stories=[r for r in self.stories if r['id']!=b['id']];d=dict(ok=True)
  else:return super().route(route)
  route.fulfill(json=d,headers={'Access-Control-Allow-Origin':'*'})
 def finish(self,index,success=True):
  route,b=self.pending[index]
  if success:
   self.wish=[p for p in self.wish if p['id']!=b['product_id']]
   if b['wished']:self.wish.append(next(p for p in self.products if p['id']==b['product_id']))
   route.fulfill(json=dict(product_id=b['product_id'],wished=b['wished']),headers={'Access-Control-Allow-Origin':'*'})
  else:route.fulfill(status=503,json=dict(error='Тестовый сбой соединения'),headers={'Access-Control-Allow-Origin':'*'})

def wire(c,f):
 c.route('https://telegram.org/**',lambda r:r.fulfill(body=TG,content_type='application/javascript'));c.route('https://*.supabase.co/**',f.route);c.route('https://qa-upload.local/**',f.upload)
 c.route('https://qa-media.local/**',lambda r:r.fulfill(path=str(ROOT/'tests/fixtures/story.mp4') if r.request.url.endswith('.mp4') else str(ROOT/'img/lamp.jpg'),content_type='video/mp4' if r.request.url.endswith('.mp4') else 'image/jpeg'))

def wait_requests(page,f,n):
 for i in range(200):
  if len(f.pending)>=n:return
  page.wait_for_timeout(20)
 raise AssertionError('Wishlist request did not arrive')

def main():
 with sync_playwright() as p:
  b=p.chromium.launch(headless=True,args=['--no-sandbox']);c=b.new_context(viewport=dict(width=390,height=844));f=ExperienceFixture();wire(c,f);page=c.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(BASE_URL,wait_until='networkidle');expect(page.locator('.story-teaser')).to_have_count(2)
  heart=page.locator('#grid [data-heart="1"]');page.evaluate('window.qaHeart=document.querySelector(\'#grid [data-heart="1"]\')');heart.click();expect(heart).to_have_attribute('aria-pressed','true');assert page.evaluate('window.qaHeart===document.querySelector(\'#grid [data-heart="1"]\')');assert heart.locator('svg').evaluate('(el)=>el.getAnimations().length')>0
  wait_requests(page,f,1);assert f.wish==[];heart.click();expect(heart).to_have_attribute('aria-pressed','false');f.finish(0);wait_requests(page,f,2);assert f.pending[1][1]['wished'] is False;f.finish(1)
  heart.click();wait_requests(page,f,3);expect(heart).to_have_attribute('aria-pressed','true');f.finish(2,False);expect(heart).to_have_attribute('aria-pressed','false');expect(page.locator('#toast')).to_contain_text('Не удалось сохранить')
  heart.click();wait_requests(page,f,4);f.finish(3);expect(heart).to_have_attribute('aria-pressed','true')
  expect(page.locator('#toast')).not_to_have_class('toast show');assert page.locator('#grid .price').first.evaluate('(e)=>getComputedStyle(e).color')=='rgb(20, 46, 89)';page.screenshot(path=str(OUT/'v4-light.png'),animations='disabled')
  page.locator('[data-theme-toggle]').click();expect(page.locator('html')).to_have_attribute('data-theme','dark');assert page.locator('#grid .price').first.evaluate('(e)=>getComputedStyle(e).color')=='rgb(255, 255, 255)';assert page.evaluate('getComputedStyle(document.body).backgroundColor')=='rgb(11, 20, 36)';page.screenshot(path=str(OUT/'v4-dark.png'),animations='disabled')
  page.reload(wait_until='networkidle');expect(page.locator('html')).to_have_attribute('data-theme','dark')
  page.locator('.tab[data-tab="profile"]').click();expect(page.locator('#deliveryId')).to_have_text('RAMP-D000001');assert 'ID для друзей' not in page.locator('#v-profile').inner_text();assert page.locator('#meId').count()==0
  page.evaluate("navigator.clipboard.writeText=(text)=>{window.qaCopied=text;return Promise.resolve();}");page.locator('#copyInviteLink').click();assert '?start=invite_' in page.evaluate('window.qaCopied')
  page.locator('[data-open-sheet="invite"]').first.click();expect(page.locator('#infoBody')).to_contain_text('−33%');assert page.locator('#refCode').count()==0;page.locator('#infoSheet [data-close-sheet]').click();page.screenshot(path=str(OUT/'v4-profile.png'),animations='disabled')
  page.locator('[data-theme-choice="light"]').click();page.locator('.tab[data-tab="catalog"]').click();page.locator('[data-story-index="0"]').click();expect(page.locator('#storyViewer')).to_be_visible();page.locator('[data-story-pause]').click();expect(page.locator('.story-caption h2')).to_have_text('Новый дроп');page.screenshot(path=str(OUT/'v4-story.png'),animations='disabled')
  page.locator('[data-story-next]').click();expect(page.locator('#storyViewer video')).to_have_count(1);page.wait_for_function("document.querySelector('#storyViewer video')?.currentTime>0",timeout=8000);page.locator('[data-story-pause]').click();assert page.locator('#storyViewer video').evaluate('(v)=>v.paused');page.locator('[data-story-close]').click();expect(page.locator('#storyViewer')).to_be_hidden();assert page.locator('#storyViewer video').count()==0
  page.goto(BASE_URL+'/admin.html',wait_until='networkidle');page.locator('.tab[data-tab="content"]').click();expect(page.locator('#contentList')).to_contain_text('Пока не уберёте');page.locator('#addContent').click();expect(page.locator('#storyLifetime')).to_have_value('24');page.locator('#storyFiles').set_input_files(str(ROOT/'img/hoodie.jpg'));page.locator('#storyTitle').fill('Фото на сутки');page.locator('[data-save-story]').click();expect(page.locator('#sheet')).not_to_have_class('sheet open',timeout=15000);assert f.saved_stories[-1]['duration_hours']==24
  page.locator('#addContent').click();page.locator('#storyTitle').fill('Постоянное видео');page.locator('#storyLifetime').select_option('forever');page.locator('#storyFiles').set_input_files(str(ROOT/'tests/fixtures/story.mp4'));page.locator('[data-save-story]').click();expect(page.locator('#sheet')).not_to_have_class('sheet open',timeout=15000);assert f.saved_stories[-1]['duration_hours'] is None and f.saved_stories[-1]['media']
  expect(page.locator('#toast')).not_to_have_class('toast show');page.screenshot(path=str(OUT/'v4-admin-stories.png'),animations='disabled');page.locator('[data-theme-toggle]').click();expect(page.locator('html')).to_have_attribute('data-theme','dark')
  for width in [320,390,1280]:
   page.set_viewport_size(dict(width=width,height=844));assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),f'Admin overflow at {width}'
  c.close()
  expiry=b.new_context(viewport=dict(width=390,height=844));ef=ExperienceFixture();ef.stories=ef.stories[:1];ef.stories[0]['expires_at']=iso(datetime.now(timezone.utc)+timedelta(seconds=3));wire(expiry,ef);pg=expiry.new_page();pg.goto(BASE_URL,wait_until='networkidle');pg.locator('[data-story-index="0"]').click();pg.locator('[data-story-pause]').click();expect(pg.locator('#storyViewer')).to_be_hidden(timeout=6000);expect(pg.locator('#homeStories')).to_be_hidden();expiry.close();b.close();assert not errors,errors
  print('PASS: optimistic/animated favorites with delayed writes, rapid taps and rollback; persistent light/dark prices; single personal ID and referral copy; photo/video stories, pause, expiry and permanent admin uploads')
if __name__=='__main__':main()
