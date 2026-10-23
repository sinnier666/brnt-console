#!/usr/bin/env python3
"""Task 29 fail-fast proof: mint a NATIVE Netflix nftoken from NetflixId.

Replicates the reference script (harshitkamboj) exactly against the iOS FTL
API, using the alive session the user pasted earlier (Task 28 probe: ALIVE).
"""
import re
import requests
import urllib3

urllib3.disable_warnings()

API_URL = "https://ios.prod.ftl.netflix.com/iosui/user/15.48"

QUERY_PARAMS = {
    "appVersion": "15.48.1",
    "config": '{"gamesInTrailersEnabled":"false","isTrailersEvidenceEnabled":"false","cdsMyListSortEnabled":"true","kidsBillboardEnabled":"true","addHorizontalBoxArtToVideoSummariesEnabled":"false","skOverlayTestEnabled":"false","homeFeedTestTVMovieListsEnabled":"false","baselineOnIpadEnabled":"true","trailersVideoIdLoggingFixEnabled":"true","postPlayPreviewsEnabled":"false","bypassContextualAssetsEnabled":"false","roarEnabled":"false","useSeason1AltLabelEnabled":"false","disableCDSSearchPaginationSectionKinds":["searchVideoCarousel"],"cdsSearchHorizontalPaginationEnabled":"true","searchPreQueryGamesEnabled":"true","kidsMyListEnabled":"true","billboardEnabled":"true","useCDSGalleryEnabled":"true","contentWarningEnabled":"true","videosInPopularGamesEnabled":"true","avifFormatEnabled":"false","sharksEnabled":"true"}',
    "device_type": "NFAPPL-02-",
    "esn": "NFAPPL-02-IPHONE8%3D1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
    "idiom": "phone",
    "iosVersion": "15.8.5",
    "isTablet": "false",
    "languages": "en-US",
    "locale": "en-US",
    "maxDeviceWidth": "375",
    "model": "saget",
    "modelType": "IPHONE8-1",
    "odpAware": "true",
    "path": '["account","token","default"]',
    "pathFormat": "graph",
    "pixelDensity": "2.0",
    "progressive": "false",
    "responseFormat": "json",
}

BASE_HEADERS = {
    "User-Agent": "Argo/15.48.1 (iPhone; iOS 15.8.5; Scale/2.00)",
    "x-netflix.request.attempt": "1",
    "x-netflix.request.client.user.guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
    "x-netflix.context.profile-guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
    "x-netflix.request.routing": '{"path":"/nq/mobile/nqios/~15.48.0/user","control_tag":"iosui_argo"}',
    "x-netflix.context.app-version": "15.48.1",
    "x-netflix.argo.translated": "true",
    "x-netflix.context.form-factor": "phone",
    "x-netflix.context.sdk-version": "2012.4",
    "x-netflix.client.appversion": "15.48.1",
    "x-netflix.context.max-device-width": "375",
    "x-netflix.context.ab-tests": "",
    "x-netflix.tracing.cl.useractionid": "4DC655F2-9C3C-4343-8229-CA1B003C3053",
    "x-netflix.client.type": "argo",
    "x-netflix.client.ftl.esn": "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
    "x-netflix.context.locales": "en-US",
    "x-netflix.context.top-level-uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
    "x-netflix.client.iosversion": "15.8.5",
    "accept-language": "en-US;q=1",
    "x-netflix.argo.abtests": "",
    "x-netflix.context.os-version": "15.8.5",
    "x-netflix.request.client.context": '{"appState":"foreground"}',
    "x-netflix.context.ui-flavor": "argo",
    "x-netflix.argo.nfnsm": "9",
    "x-netflix.context.pixel-density": "2.0",
    "x-netflix.request.toplevel.uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
    "x-netflix.request.client.timezoneid": "Asia/Dhaka",
}

NETFLIX_ID = "ct%3DBgjHlOvcAxLHAySXyYOze5-ZO0igBeZS8pa5mbf3ZSpU4NkC7j5iCOCIayujm-Nqn0z_pWFhXK6EdzSJQ_Q3B0BoF_phng1nRuBYS4QHOngK60JM3X7-rfmuiqfRjEVAKzd_ep_mhN5S-oDJZ3r5mNVA3tb2yXYwZ5SRrKaam23ux9Ajr7_SGNlziu9NJXQMo4YzYfaCrwbgm3u-Bs13lfL-maZ6ZlqHKUQXCbn3sPrN-vP9wD6NQcJKeJqLFLUjfxYEp1XOVCn5z3y06c8uh-7hqQ4fW7LFawZZkuyl6_c5Vqu3CuzzNxXPowgW5j-eqMHWjWYxFIe8D-75WaCUjYF5r7yKmIIHG0_d4hxLcYewxubYIPDnIR1kgPGAtJdJd9_FQ8YJCsNNWqNp_lZMlZJ2HxBGBkTE7FhuYGi9ZhXyw13IS6hF7oOht9z-8j7zMPYB7uxTymCigl0O23YHbm_xq6nOAjPFZ1cjZitpjoHTtxUYVsSYM2HFvsFSTniGMwjHF0a_nt98WOygyLKDBTlxmFTC-Yt9x1_e84-Fl0KYoEEPAaEk-ZuVSRLn9tz7HF9hLCzhYKnpEob0KVoHQ5o4Ac2I7izJgMR2QuYhrfJeGAYiDgoMEBDx-51OKBEOWLDQ%26ch%3DAQEAEAABABQRy0hw6ASVj9po9vUcNlK-XoKu3xcMac0.%26v%3D3%26pg%3DXJT4MUNLEVADDABP27QC5LFZNA"


def attempt(label: str, cookie_value: str):
    headers = dict(BASE_HEADERS)
    headers["Cookie"] = f"NetflixId={cookie_value}"
    r = requests.get(API_URL, params=QUERY_PARAMS, headers=headers,
                     timeout=30, verify=False)
    print(f"[{label}] HTTP {r.status_code}, {len(r.content)} bytes")
    if r.status_code != 200:
        print("  body head:", r.text[:200].replace("\n", " "))
        return None
    data = r.json()
    tok = ((((data.get("value") or {}).get("account") or {}).get("token") or {}).get("default") or {})
    token = tok.get("token")
    expires = tok.get("expires")
    if not token:
        print("  200 but no token. top keys:", list(data.get("value", {}).keys())[:8])
        return None
    print(f"  token: {token[:24]}...{token[-12:]} (len {len(token)})")
    print(f"  expires raw: {expires}")
    print(f"  NATIVE LINK: https://netflix.com/?nftoken={token[:40]}...")
    return token, expires


def main():
    ok = attempt("raw (encoded) value", NETFLIX_ID)
    if not ok:
        import urllib.parse
        ok = attempt("unquoted value", urllib.parse.unquote(NETFLIX_ID))
    print("RESULT:", "MINT OK" if ok else "MINT FAILED")


if __name__ == "__main__":
    main()
