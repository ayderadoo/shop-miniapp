"""User/admin workflows against isolated fixtures, including direct media uploads."""
import copy
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
from browser import Fixture,TG,ROOT,OUT,BASE_URL

class ContentFixture(Fixture):
 def __init__(self):
  super().__init__();self.saved_news=None;self.saved_review=None;self.uploads={};self.uploaded=[]
  self.news=[dict(id=1,title='Поступление на этой неделе',body='Новые цвета и размеры уже в каталоге.',published=True,pinned=True,position=0,media=[],created_at='2026-10-20T10:00:00Z')]
  self.reviews=[dict(id=1,telegram_id=202,product_id=None,author_name='Малика',rating=5,body='Удобно заказывать, всё понравилось.',source='customer',status='approved',media=[],verified_purchase=True,created_at='2026-10-20T10:00:00Z'),dict(id=2,telegram_id=203,product_id=2,author_name='Дилшод',rating=4,body='Хорошее качество ткани.',source='customer',status='pending',media=[],verified_purchase=False,created_at='2026-10-20T10:00:00Z',product=dict(name='Худи',sku='RM-600001'))]
 def media(self,ids):return [dict(upload_id=x,mime=self.uploads[x]['mime'],url='https://qa-media.local/'+('clip.mp4' if self.uploads[x]['mime'].startswith('video/') else 'lamp.jpg')) for x in ids]
 def route(self,route):
  req=route.request
  if req.method=='OPTIONS':return route.fulfill(status=204,headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'PUT,POST,OPTIONS'})
  if not '/functions/v1/' in req.url:return super().route(route)
  body=req.post_data_json or {};action=body.get('action');admin='/admin' in req.url;data=None
  if action=='stories':data=dict(stories=[n for n in self.news if admin or n['published']],has_more=False)
  elif action=='reviews':
   if admin:rows=[r for r in self.reviews if not body.get('status') or r['status']==body['status']];data=dict(reviews=rows,has_more=False)
   else:
    product=body.get('product_id');rows=[r for r in self.reviews if r['status']=='approved' and (not product or r['product_id']==product)]
    mine=next((r for r in self.reviews if r['telegram_id']==101 and r['source']=='customer' and r['product_id']==product),None)
    data=dict(reviews=rows,mine=mine,stats=dict(count=len(rows),rating=5),has_more=False)
  elif action=='createMediaUpload':
   uid=f'00000000-0000-4000-8000-{len(self.uploads)+1:012d}';self.uploads[uid]=body;data=dict(upload_id=uid,signed_url='https://qa-upload.local/'+uid)
  elif action=='saveReview':
   self.saved_review=body;row=dict(id=10,telegram_id=101,product_id=body.get('product_id'),author_name='Азиз',rating=body['rating'],body=body['body'],source='customer',status='pending',media=self.media(body['media']),created_at='2026-10-20T12:00:00Z')
   self.reviews.append(row);data=dict(review=row)
  elif action=='saveStory':
   self.saved_news=body;row=dict(body,id=body.get('id') or 3,media=self.media(body['media']),created_at='2026-10-20T12:00:00Z');self.news=[n for n in self.news if n['id']!=row['id']]+[row];data=dict(story=row)
  elif action=='moderateReview':
   for row in self.reviews:
    if row['id']==body['id']:row['status']=body['status']
   data=dict(ok=True)
  elif action=='saveStoreReview':
   self.saved_review=body;row=dict(body,id=body.get('id') or 20,telegram_id=101,product_id=int(body['product_id']) if body.get('product_id') else None,media=self.media(body['media']),source='store',status='approved' if body['published'] else 'pending',created_at='2026-10-20T12:00:00Z');self.reviews.append(row);data=dict(review=row)
  if data is None:return super().route(route)
  return route.fulfill(json=data,headers={'Access-Control-Allow-Origin':'*'})
 def upload(self,route):
  if route.request.method=='OPTIONS':return route.fulfill(status=204,headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'PUT,OPTIONS'})
  assert route.request.method=='PUT';self.uploaded.append(dict(id=route.request.url.split('/')[-1],mime=route.request.headers.get('content-type')))
  return route.fulfill(json={'Key':'ok'},headers={'Access-Control-Allow-Origin':'*'})

def main():
 with sync_playwright() as p:
  b=p.chromium.launch(headless=True,args=['--no-sandbox']);c=b.new_context(viewport=dict(width=390,height=844));f=ContentFixture()
  c.route('https://telegram.org/**',lambda r:r.fulfill(body=TG,content_type='application/javascript'));c.route('https://*.supabase.co/**',f.route);c.route('https://qa-upload.local/**',f.upload)
  c.route('https://qa-media.local/**',lambda r:r.fulfill(path=str(ROOT/'img/lamp.jpg'),content_type='image/jpeg'))
  page=c.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(BASE_URL,wait_until='networkidle');expect(page.locator('#storyRail')).to_contain_text('Поступление');expect(page.locator('#homeReviewList')).to_contain_text('Малика')
  page.screenshot(path=str(OUT/'v2-shop-news.png'),full_page=True,animations='disabled')
  page.locator('[data-story-index="0"]').click();expect(page.locator('#storyViewer')).to_be_visible();page.locator('[data-story-close]').click()
  page.locator('#writeShopReview').click();page.locator('#reviewBody').fill('Тестовый отзыв с фотографией и видео.');page.locator('[data-review-rating="4"]').click()
  page.locator('#reviewFiles').set_input_files([dict(name='lamp.jpg',mimeType='image/jpeg',buffer=(ROOT/'img/lamp.jpg').read_bytes()),dict(name='clip.mp4',mimeType='video/mp4',buffer=b'QA video upload payload')])
  page.locator('[data-submit-review]').click();expect(page.locator('#infoSheet')).not_to_have_class('sheet open',timeout=15000)
  assert len(f.uploaded)==2 and f.uploaded[1]['mime']=='video/mp4';assert f.saved_review['rating']==4 and len(f.saved_review['media'])==2
  page.locator('.tab[data-tab="profile"]').click();expect(page.locator('#deliveryId')).to_have_text('RP-1');page.screenshot(path=str(OUT/'v2-delivery-profile.png'),full_page=True,animations='disabled')
  page.goto(BASE_URL+'/admin.html',wait_until='networkidle');page.locator('.tab[data-tab="users"]').click();page.locator('[data-uf="registry"]').click();expect(page.locator('#uList')).to_contain_text('RP-1')
  page.locator('.tab[data-tab="products"]').click();page.locator('[data-product="2"]').click();expect(page.locator('#epSku')).to_have_value('600001');page.locator('#optionTemplate').select_option('volume');page.locator('[data-apply-template]').click();expect(page.locator('[data-option-name]').nth(1)).to_have_value('Объём');page.locator('#epDesc').fill('Изменённое описание из админки');page.locator('#shBar [data-act="saveProduct"]').click();expect(page.locator('#sheet')).not_to_have_class('sheet open');assert f.saved_product['options'][1]['name']=='Объём' and f.saved_product['sku']=='RM-600001'
  page.locator('.tab[data-tab="content"]').click();expect(page.locator('#contentList')).to_contain_text('Поступление');page.locator('#addContent').click();page.locator('#storyTitle').fill('История из админки');page.locator('#storyBody').fill('Подборка товаров для дома.');expect(page.locator('#storyLifetime')).to_have_value('24')
  page.locator('#storyFiles').set_input_files(str(ROOT/'img/headphones.jpg'));page.locator('[data-save-story]').click();expect(page.locator('#sheet')).not_to_have_class('sheet open',timeout=15000);assert f.saved_news['published'] and f.saved_news['duration_hours']==24 and len(f.saved_news['media'])==1
  page.screenshot(path=str(OUT/'v2-admin-content.png'),full_page=True,animations='disabled')
  page.locator('[data-content-mode="reviews"]').click();page.locator('[data-edit-review="2"]').click();page.locator('[data-moderate-review="approved"]').click();expect(page.locator('#sheet')).not_to_have_class('sheet open');assert next(r for r in f.reviews if r['id']==2)['status']=='approved'
  page.locator('#addContent').click();page.locator('#storeReviewAuthor').fill('Автор видео');page.locator('#storeReviewProduct').select_option('3');page.locator('#storeReviewBody').fill('Видеоотзыв покупателя');page.locator('#storeReviewFiles').set_input_files(dict(name='review.mp4',mimeType='video/mp4',buffer=b'QA video'))
  page.locator('[data-save-store-review]').click();expect(page.locator('#sheet')).not_to_have_class('sheet open',timeout=15000);assert f.saved_review['product_id']=='3' and f.saved_review['published'] and len(f.saved_review['media'])==1
  page.set_viewport_size(dict(width=320,height=740));assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),'Content admin overflow'
  page.set_viewport_size(dict(width=1280,height=900));page.screenshot(path=str(OUT/'v2-admin-desktop.png'),full_page=True,animations='disabled')
  c.close()
  foreign=b.new_context(viewport=dict(width=390,height=844));bad=ContentFixture();bad.profile.update(tg_phone='+79991234567',phone_verified=False)
  foreign.route('https://telegram.org/**',lambda r:r.fulfill(body=TG,content_type='application/javascript'));foreign.route('https://*.supabase.co/**',bad.route)
  page=foreign.new_page();page.goto(BASE_URL,wait_until='networkidle');expect(page.locator('#gate')).to_have_class('gate show');expect(page.locator('#gateTitle')).to_contain_text('Узбекистана')
  foreign.close();b.close();assert not errors,errors
  print('PASS: news editor and preview, photo/video review uploads, moderation, store reviews, delivery IDs, SKU editor, parameter templates, UZ gate and responsive content layouts')

if __name__=='__main__':main()
