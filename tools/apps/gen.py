#!/usr/bin/env python3
"""Собирает проекты приложений «ИИгр»: Android (WebView) и Windows (Electron).
Приложение открывает живую страницу игры (рекорды, покупки, обновления работают),
а без интернета — встроенную копию игры. Запуск: python tools/apps/gen.py <slug> <номер_сборки>"""
import json, os, shutil, sys

SITE = "https://dsaskarov.github.io"
APPS = {
    "iigry":        ("ИИгры онлайн", "/", "index.html"),
    "pulsar":       ("Пульсар", "/games/pulsar.html", "games/pulsar.html"),
    "zhezl":        ("Жезл", "/games/zhezl.html", "games/zhezl.html"),
    "s-nulya":      ("Жизнь с нуля", "/games/s-nulya.html", "games/s-nulya.html"),
    "kontinenty":   ("Континенты", "/games/kontinenty.html", "games/kontinenty.html"),
    "lovi-bagi":    ("Лови баги", "/games/lovi-bagi.html", "games/lovi-bagi.html"),
    "kot-na-orbite": ("Кот на орбите", "/games/kot-na-orbite.html", "games/kot-na-orbite.html"),
    "ferma-slov":   ("Ферма слов", "/games/ferma-slov.html", "games/ferma-slov.html"),
    "origami":      ("Оригами-блоки", "/games/origami.html", "games/origami.html"),
}

def main():
    slug, build = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 1
    name, path, local = APPS[slug]
    url = SITE + path
    pkg = "io.github.dsaskarov." + slug.replace("-", "")
    root = os.path.join("build", slug)
    shutil.rmtree(root, ignore_errors=True)
    game = slug != "iigry"
    icon = os.path.join("tools/apps/icons", slug + ".png")
    if not os.path.exists(icon): icon = "icon-512.png"
    asset = "games/" + slug + ".html" if game else "index.html"  # путь с /games/ включает в игре режим приложения

    # ---------- Android
    a = os.path.join(root, "android")
    j = os.path.join(a, "app/src/main/java", *pkg.split("."))
    os.makedirs(j); os.makedirs(os.path.join(a, "app/src/main/assets/games"))
    os.makedirs(os.path.join(a, "app/src/main/res/mipmap-xxxhdpi"))
    open(os.path.join(a, "settings.gradle"), "w").write(
        "pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\n"
        "dependencyResolutionManagement { repositories { google(); mavenCentral() } }\n"
        "rootProject.name = 'app'\ninclude ':app'\n")
    open(os.path.join(a, "build.gradle"), "w").write("plugins { id 'com.android.application' version '8.5.2' apply false }\n")
    open(os.path.join(a, "gradle.properties"), "w").write("org.gradle.jvmargs=-Xmx2g\nandroid.nonTransitiveRClass=true\n")
    open(os.path.join(a, "app/build.gradle"), "w").write(f"""plugins {{ id 'com.android.application' }}
android {{
  namespace '{pkg}'
  compileSdk 34
  defaultConfig {{ applicationId '{pkg}'; minSdk 24; targetSdk 34; versionCode {build}; versionName '1.{build}' }}
  buildTypes {{ debug {{ minifyEnabled false }}; release {{ minifyEnabled false }} }}
}}
""")
    open(os.path.join(a, "app/src/main/AndroidManifest.xml"), "w").write(f"""<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET"/>
  <application android:label="{name}" android:icon="@mipmap/ic_launcher" android:theme="@android:style/Theme.Material.NoActionBar" android:hardwareAccelerated="true" android:allowBackup="true">
    <activity android:name=".MainActivity" android:exported="true" android:configChanges="orientation|screenSize|keyboardHidden|screenLayout">
      <intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>
    </activity>
  </application>
</manifest>
""")
    keep = url if game else SITE + "/"
    imm = "true" if game else "false"
    open(os.path.join(j, "MainActivity.java"), "w").write(f"""package {pkg};
import android.app.Activity;
import android.os.Bundle;
import android.content.Intent;
import android.net.Uri;
import android.view.View;
import android.view.Window;
import android.webkit.*;
public class MainActivity extends Activity {{
  private WebView w;
  @Override protected void onCreate(Bundle b) {{
    super.onCreate(b);
    requestWindowFeature(Window.FEATURE_NO_TITLE);
    w = new WebView(this);
    WebSettings s = w.getSettings();
    s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setDatabaseEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setUserAgentString(s.getUserAgentString() + " IIgryApp");
    w.setWebChromeClient(new WebChromeClient());
    w.setWebViewClient(new WebViewClient() {{
      @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {{
        if (r.isForMainFrame()) v.loadUrl("file:///android_asset/{asset}");
      }}
      @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {{
        String u = r.getUrl().toString();
        if (u.startsWith("{keep}") || u.startsWith("file:///android_asset/")) return false;
        try {{ startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u))); }} catch (Exception x) {{}}
        return true;
      }}
    }});
    setContentView(w);
    if ({imm}) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    if (b != null) w.restoreState(b); else w.loadUrl("{url}");
  }}
  @Override protected void onSaveInstanceState(Bundle o) {{ super.onSaveInstanceState(o); w.saveState(o); }}
  @Override public void onBackPressed() {{ if (w.canGoBack()) w.goBack(); else super.onBackPressed(); }}
}}
""")
    shutil.copy(local, os.path.join(a, "app/src/main/assets", asset))
    shutil.copy(icon, os.path.join(a, "app/src/main/res/mipmap-xxxhdpi/ic_launcher.png"))

    # ---------- Windows (Electron, установщик NSIS)
    e = os.path.join(root, "electron"); os.makedirs(e)
    os.makedirs(os.path.join(e, "games")); shutil.copy(local, os.path.join(e, asset)); shutil.copy(icon, os.path.join(e, "icon.png"))
    open(os.path.join(e, "main.js"), "w").write(f"""const {{app, BrowserWindow, Menu, shell}} = require('electron');
const path = require('path');
app.userAgentFallback = app.userAgentFallback + ' IIgryApp';
const KEEP = {json.dumps(url if game else SITE + "/")};
app.whenReady().then(() => {{
  Menu.setApplicationMenu(null);
  const w = new BrowserWindow({{width: 1100, height: 860, backgroundColor: '#0B0A0E', icon: path.join(__dirname, 'icon.png'), title: {json.dumps(name)}, webPreferences: {{contextIsolation: true, sandbox: true}}}});
  w.webContents.on('did-fail-load', (ev, code, desc, url, isMain) => {{ if (isMain && !String(url).startsWith('file:')) w.loadFile(path.join(__dirname, {json.dumps(asset)})); }});
  w.webContents.on('will-navigate', (ev, url) => {{ if (!url.startsWith(KEEP) && !url.startsWith('file:')) {{ ev.preventDefault(); if (/^https:/.test(url)) shell.openExternal(url); }} }});
  w.webContents.setWindowOpenHandler(({{url}}) => {{ if (/^https:/.test(url)) shell.openExternal(url); return {{action: 'deny'}}; }});
  w.loadURL({json.dumps(url)});
}});
app.on('window-all-closed', () => app.quit());
""")
    json.dump({"name": slug, "productName": name, "version": f"1.0.{build}", "description": name + " — игра «ИИгры онлайн»", "author": "DSAskarov", "main": "main.js",
               "build": {"appId": pkg, "artifactName": slug + "-setup.${ext}", "files": ["main.js", "index.html", "games/**", "icon.png"],
                         "win": {"target": "nsis", "icon": "icon.png"},
                         "nsis": {"oneClick": False, "allowToChangeInstallationDirectory": True, "createDesktopShortcut": True, "shortcutName": name, "language": "1049"}}},
              open(os.path.join(e, "package.json"), "w"), ensure_ascii=False, indent=1)
    print("ok", slug)

if __name__ == "__main__":
    main()
