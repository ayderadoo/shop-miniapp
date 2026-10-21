"""Bundle CSS, scripts, fonts and fallback photos into two HTML files for mobile GitHub uploads."""
import argparse,base64,json,re,subprocess
from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);parser.add_argument('--archive',required=True);args=parser.parse_args()
 root=Path(__file__).resolve().parents[1];out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
 def uri(path,mime):return 'data:'+mime+';base64,'+base64.b64encode(path.read_bytes()).decode()
 css=(root/'assets/fonts.css').read_text()
 def font(match):
  path=root/'assets'/match.group(1);magic=path.read_bytes()[:4];mime='font/woff2' if magic==b'wOF2' else 'font/woff' if magic==b'wOFF' else 'font/ttf'
  return 'url('+uri(path,mime)+')'
 css=re.sub(r'url\((fonts/[^)]+)\)',font,css)
 photos={name:uri(root/'img'/name,'image/jpeg') for name in ['lamp.jpg','hoodie.jpg','headphones.jpg']}
 ui='const embeddedPhotos='+json.dumps(photos)+';\n'+(root/'assets/ui.js').read_text()
 ui=ui.replace("img.src = 'img/placeholder.svg';",'const name=new URL(img.src,location.href).pathname.split("/").pop();\n    if(embeddedPhotos[name])img.classList.remove("image-fallback");\n    img.src=embeddedPhotos[name] || '+json.dumps(uri(root/'img/placeholder.svg','image/svg+xml'))+';')
 for page in ['index.html','admin.html']:
  html=(root/page).read_text().replace('<link rel="stylesheet" href="assets/fonts.css">','<style>'+css+'</style>')
  for name in ['ui.css','navy.css','stories.css']:
   html=html.replace(f'<link rel="stylesheet" href="assets/{name}">','<style>'+(root/'assets'/name).read_text()+'</style>')
  for name in ['ui.js','export.js','content-ui.js','theme.js','wishlist.js','stories.js']:
   source=(ui if name=='ui.js' else (root/'assets'/name).read_text()).replace('</script','<\\/script')
   html=html.replace(f'<script src="assets/{name}" defer></script>',"<script>document.addEventListener('DOMContentLoaded',()=>{\n"+source+'\n});</script>')
   html=html.replace(f'<script src="assets/{name}"></script>','<script>\n'+source+'\n</script>')
  assert 'href="assets/' not in html and 'src="assets/' not in html
  (out/page).write_text(html)
  for i,source in enumerate(re.findall(r'<script>(.*?)</script>',html,re.S)):
   check=Path(f'/tmp/ramp-v2-mobile-{page}-{i}.js');check.write_text(source)
   subprocess.run(['node','--check',str(check)],check=True,capture_output=True)
  print(page,(out/page).stat().st_size,'bytes')
 archive=Path(args.archive)
 with ZipFile(archive,'w',ZIP_DEFLATED) as z:
  for page in ['index.html','admin.html']:z.write(out/page,page)
 with ZipFile(archive) as z:assert z.testzip() is None and z.namelist()==['index.html','admin.html']
 print('Verified mobile archive:',archive)

if __name__=='__main__':main()
