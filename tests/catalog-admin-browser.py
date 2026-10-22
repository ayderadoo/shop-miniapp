"""22.10: видео в поиске по фото, артикулы RM-, личные ID RP-, удаление товара, вёрстка каталога. Telegram/API изолированы."""
import copy
from playwright.sync_api import sync_playwright, expect
from browser import Fixture, TG, ROOT, OUT, BASE_URL

UPLOAD_PATH = '101/0f8fad5b-d9cb-469f-a165-70867728950e.mp4'

class F(Fixture):
 def __init__(self):
  super().__init__()
  extra = []
  for i, category in enumerate(['Наушники', 'Аксессуары', 'Обувь', 'Красота', 'Спорт'], start=4):
   product = copy.deepcopy(self.products[i % 3]); product.update(id=i, name=f'Товар {i}', category=category, sku=f'RM-{599999 + i}'); extra.append(product)
  self.products += extra
  self.requests = []; self.calls = []; self.uploads = []
 def route(self, route):
  req = route.request
  if req.method != 'OPTIONS' and '/functions/v1/' in req.url:
   b = req.post_data_json or {}; a = b.get('action'); self.calls.append((a, b))
   if '/functions/v1/admin' not in req.url:
    if a == 'createRequestUpload':
     assert b['mime'] == 'video/mp4' and b['size'] > 0
     return route.fulfill(json=dict(path=UPLOAD_PATH, signed_url='https://qa-upload.local/put'), headers={'Access-Control-Allow-Origin': '*'})
    if a == 'photoRequest':
     assert b.get('video_path') == UPLOAD_PATH and 'image' not in b, b
     self.requests = [dict(id=7, media_type='video', photo_url='https://qa-media.local/story.mp4', comment=b.get('comment'), status='new', created_at='2026-10-22T10:00:00Z')]
     return route.fulfill(json=dict(requests=self.requests), headers={'Access-Control-Allow-Origin': '*'})
    if a == 'photoRequests':
     return route.fulfill(json=dict(requests=self.requests), headers={'Access-Control-Allow-Origin': '*'})
   else:
    if a == 'removeProduct':
     self.products = [p for p in self.products if p['id'] != b['id']]
     return route.fulfill(json=dict(removed=True, id=b['id']), headers={'Access-Control-Allow-Origin': '*'})
    if a == 'requests':
     return route.fulfill(json=dict(requests=[dict(id=7, telegram_id=101, media_type='video', photo_url='https://qa-media.local/story.mp4', comment='Нужен такой же', status='new', created_at='2026-10-22T10:00:00Z', user=self.profile)], has_more=False), headers={'Access-Control-Allow-Origin': '*'})
  return super().route(route)
 def upload(self, route):
  assert route.request.method == 'PUT' and route.request.headers['content-type'] == 'video/mp4'
  self.uploads.append(len(route.request.post_data_buffer or b''))
  route.fulfill(status=200, json=dict(Key='requests/' + UPLOAD_PATH), headers={'Access-Control-Allow-Origin': '*'})

def wire(context, f):
 context.route('https://telegram.org/**', lambda r: r.fulfill(body=TG, content_type='application/javascript'))
 context.route('https://*.supabase.co/**', f.route)
 context.route('https://qa-upload.local/**', f.upload)
 context.route('https://qa-media.local/**', lambda r: r.fulfill(path=str(ROOT / 'tests/fixtures/story.mp4'), content_type='video/mp4'))

def main():
 with sync_playwright() as p:
  browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
  for width in [320, 390]:
   c = browser.new_context(viewport=dict(width=width, height=800)); f = F(); wire(c, f); page = c.new_page()
   page.goto(BASE_URL, wait_until='networkidle'); expect(page.locator('#grid .card')).to_have_count(8)
   chips = page.locator('#chips').bounding_box(); toggle = page.locator('#viewToggle').bounding_box()
   assert chips['x'] + chips['width'] <= toggle['x'] - 8, (chips, toggle)
   assert abs((chips['y'] + chips['height'] / 2) - (toggle['y'] + toggle['height'] / 2)) <= 1.5, (chips, toggle)
   assert 'gradient' in page.locator('#chips').evaluate("e=>getComputedStyle(e).webkitMaskImage||getComputedStyle(e).maskImage")
   theme = page.locator('.hero-top [data-theme-toggle]').bounding_box(); channel = page.locator('.hero-top .channel-link').bounding_box()
   assert theme['height'] == channel['height'] == theme['width'] and abs(theme['y'] - channel['y']) < 0.5, (theme, channel)
   assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'Shop overflow at {width}'
   c.close()

  c = browser.new_context(viewport=dict(width=390, height=844)); f = F(); wire(c, f); page = c.new_page(); errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
  page.goto(BASE_URL, wait_until='networkidle')
  page.locator('#grid .card').nth(1).locator('.img, img').first.click(); expect(page.locator('#productSheet')).to_have_class('sheet open')
  expect(page.locator('#psCat')).to_have_text('Одежда'); expect(page.locator('.sku-note')).to_have_text('Артикул RM-600001')
  page.evaluate("navigator.clipboard.writeText=(text)=>{window.qaCopied=text;return Promise.resolve();}"); page.locator('.sku-note').click()
  page.wait_for_function("window.qaCopied==='RM-600001'"); page.locator('.sku-note').scroll_into_view_if_needed()
  page.screenshot(path=str(OUT / 'v5-product-sku.png'), animations='disabled')
  page.keyboard.press('Escape'); page.goto(BASE_URL + '/?tab=photo', wait_until='networkidle')
  page.locator('.tab[data-tab="photo"]').click(); expect(page.locator('#drop')).to_contain_text('фото или видео')
  page.locator('#photoInput').set_input_files(str(ROOT / 'tests/fixtures/story.mp4'))
  expect(page.locator('#previewVideo')).to_be_visible(); expect(page.locator('#photoReplace')).to_be_visible(); expect(page.locator('#photoSend')).to_be_enabled()
  page.locator('#photoComment').fill('Нужен такой же, размер M'); page.locator('#photoSend').click()
  expect(page.locator('#photoList .video-thumb')).to_have_count(1); expect(page.locator('#previewVideo')).to_be_hidden(); expect(page.locator('#drop')).to_be_visible()
  assert f.uploads and f.uploads[0] > 0 and [a for a, _ in f.calls if a in ('createRequestUpload', 'photoRequest')] == ['createRequestUpload', 'photoRequest']
  page.screenshot(path=str(OUT / 'v5-photo-video.png'), animations='disabled')

  page.goto(BASE_URL + '/admin.html', wait_until='networkidle'); page.locator('.tab[data-tab="products"]').click()
  page.locator('#pAdd').click(); expect(page.locator('#epSku')).to_have_value('600008')
  expect(page.locator('[data-pick-cat]')).to_have_count(8); page.locator('[data-pick-cat="Наушники"]').click(); expect(page.locator('#epCat')).to_have_value('Наушники')
  page.locator('#epName').fill('Наушники-вкладыши'); page.locator('#epPrice').fill('150000')
  page.locator('#epSku').fill('123'); page.locator('#shBar [data-act="saveProduct"]').click(); expect(page.locator('#toast')).to_contain_text('от 600000'); assert f.saved_product is None
  page.locator('#epSku').fill('600050'); page.screenshot(path=str(OUT / 'v5-admin-new-product.png'), full_page=True, animations='disabled')
  page.locator('#shBar [data-act="saveProduct"]').click(); expect(page.locator('#sheet')).not_to_have_class('sheet open')
  assert f.saved_product['sku'] == 'RM-600050' and f.saved_product['category'] == 'Наушники', f.saved_product
  page.locator('[data-product="5"]').click(); expect(page.locator('#epSku')).to_have_value('600004')
  expect(page.locator('[data-act="removeProduct"]')).to_be_visible(); page.locator('[data-act="removeProduct"]').scroll_into_view_if_needed()
  page.screenshot(path=str(OUT / 'v5-admin-remove.png'), animations='disabled')
  page.locator('[data-act="removeProduct"]').click(); expect(page.locator('#sheet')).not_to_have_class('sheet open'); expect(page.locator('[data-product="5"]')).to_have_count(0)
  assert ('removeProduct', {'action': 'removeProduct', 'id': 5}) in [(a, {k: v for k, v in b.items() if k in ('action', 'id')}) for a, b in f.calls]
  page.locator('.tab[data-tab="requests"]').click(); expect(page.locator('#rList video.req-img')).to_have_count(1)
  page.locator('.tab[data-tab="users"]').click(); expect(page.locator('#uList')).to_contain_text('RP-1 · Каримов Азиз')
  c.close(); browser.close(); assert not errors, errors
  print('PASS: chips/toggle layout at 320/390, aligned theme button, quiet copyable SKU, short video photo search, RM- SKU editor with category picks, permanent product removal, video requests in admin, RP- IDs')

if __name__ == '__main__':
 main()
