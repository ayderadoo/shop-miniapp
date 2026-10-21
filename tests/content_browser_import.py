import importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('ramp_content_browser',Path(__file__).with_name('content-browser.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
ContentFixture=module.ContentFixture
