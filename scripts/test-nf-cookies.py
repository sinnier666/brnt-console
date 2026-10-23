#!/usr/bin/env python3
"""Task 28: aliveness test of the Netflix session cookies pasted by the user.

Differential method (same logic as the BRNT probe):
  - request netflix.com/YourAccount WITH the cookie jar  -> expect 200 account page
  - same request WITHOUT cookies (control)               -> expect redirect to /login
"""
import re
import requests

NETSCAPE = (
    "# Netscape HTTP Cookie File\n"
    "#HttpOnly_.netflix.com\tTRUE\t/\tTRUE\t1821295654\tNetflixId\tct%3DBgjHlOvcAxLHAySXyYOze5-ZO0igBeZS8pa5mbf3ZSpU4NkC7j5iCOCIayujm-Nqn0z_pWFhXK6EdzSJQ_Q3B0BoF_phng1nRuBYS4QHOngK60JM3X7-rfmuiqfRjEVAKzd_ep_mhN5S-oDJZ3r5mNVA3tb2yXYwZ5SRrKaam23ux9Ajr7_SGNlziu9NJXQMo4YzYfaCrwbgm3u-Bs13lfL-maZ6ZlqHKUQXCbn3sPrN-vP9wD6NQcJKeJqLFLUjfxYEp1XOVCn5z3y06c8uh-7hqQ4fW7LFawZZkuyl6_c5Vqu3CuzzNxXPowgW5j-eqMHWjWYxFIe8D-75WaCUjYF5r7yKmIIHG0_d4hxLcYewxubYIPDnIR1kgPGAtJdJd9_FQ8YJCsNNWqNp_lZMlZJ2HxBGBkTE7FhuYGi9ZhXyw13IS6hF7oOht9z-8j7zMPYB7uxTymCigl0O23YHbm_xq6nOAjPFZ1cjZitpjoHTtxUYVsSYM2HFvsFSTniGMwjHF0a_nt98WOygyLKDBTlxmFTC-Yt9x1_e84-Fl0KYoEEPAaEk-ZuVSRLn9tz7HF9hLCzhYKnpEob0KVoHQ5o4Ac2I7izJgMR2QuYhrfJeGAYiDgoMEBDx-51OKBEOWLDQ%26ch%3DAQEAEAABABQRy0hw6ASVj9po9vUcNlK-XoKu3xcMac0.%26v%3D3%26pg%3DXJT4MUNLEVADDABP27QC5LFZNA\n"
    ".netflix.com\tTRUE\t/\tFALSE\t1797535657\tnetflix-sans-bold-3-loaded\ttrue\n"
    ".netflix.com\tTRUE\t/\tFALSE\t1797535657\tnetflix-sans-normal-3-loaded\ttrue\n"
    ".netflix.com\tTRUE\t/\tFALSE\t1820006285\tnfvdid\tBQFmAAEBEEpxUykQyUa93Pz7unxYEuFgC9_Wunm4QdFGrl9vbIq9hMeZW_mysj_vV4IPZCDjvpg3N-W2T35k0XtrfvN95GO8IEZIKgnkv_Ooo_EK5rSabzJzIP2b0r_D7xOOLSpnGudM0UO0hw2o4-8Gk6V1x2fz\n"
    ".netflix.com\tTRUE\t/\tFALSE\t1820004238\tOptanonAlertBoxClosed\t2026-09-03T20:43:58.609Z\n"
    ".netflix.com\tTRUE\t/\tFALSE\t1821295658\tOptanonConsent\tisGpcEnabled=0&datestamp=Fri+Sep+18+2026+13%3A27%3A38+GMT-0600+(hora+est%C3%A1ndar+central)&version=202607.1.0&browserGpcFlag=0&isDntEnabled=0&isIABGlobal=false&hosts=&consentId=0f78b0c8-ff10-43e2-a63c-ce5dfccb3b9f&interactionCount=1&isAnonUser=1&prevHadToken=0&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A1&fclco=&lastConsentTs=1788468238&intType=3&crTime=1788468239450&geolocation=MX%3BGUA&AwaitingReconsent=false\n"
    "#HttpOnly_.netflix.com\tTRUE\t/\tTRUE\t1821295654\tSecureNetflixId\tv%3D3%26mac%3DAQEAEQABABRmQf9N4H-ds4bK_MtHMXqLueD2QHErWro.%26dt%3D1789761187556\n"
)

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


def build_header(netscape_text: str) -> str:
    pairs = []
    for raw in netscape_text.splitlines():
        line = raw.strip()
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_"):]
        if not line or line.startswith("#"):
            continue
        f = line.split("\t")
        if len(f) == 7 and f[5]:
            pairs.append((f[5], f[6]))
    return "; ".join(f"{n}={v}" for n, v in pairs)


def mask_email(body: str):
    m = re.search(r'"email":"([^"]{1,60})"', body)
    if m:
        e = m.group(1)
        user, _, dom = e.partition("@")
        print(f"  account email: {user[:2]}***@{dom}")


def probe(label: str, cookie_header: str | None):
    h = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9,es;q=0.8"}
    if cookie_header:
        h["Cookie"] = cookie_header
    try:
        r = requests.get("https://www.netflix.com/YourAccount",
                         headers=h, allow_redirects=True, timeout=30)
    except Exception as exc:
        print(f"[{label}] ERROR: {exc!r}")
        return None
    print(f"[{label}] status={r.status_code} final={r.url} bytes={len(r.text)}")
    low = r.text.lower()
    markers = ("sign out", "signout", "isloggedin", "membershipstatus",
               "who's watching", "sign in", "login password", "authredirect")
    for mk in markers:
        if mk in low:
            print(f"  contains marker: {mk!r}")
    for rx, name in ((r'"isLoggedIn":(true|false)', "isLoggedIn"),
                     (r'"membershipStatus":"([^"]{0,40})"', "membershipStatus"),
                     (r'"isMember":(true|false)', "isMember")):
        m = re.search(rx, r.text)
        if m:
            print(f"  {name} = {m.group(1)}")
    mask_email(r.text)
    return r


def main() -> None:
    header = build_header(NETSCAPE)
    print(f"cookie header built: {len(header)} chars, "
          f"{header.count(';') + 1} cookies, "
          f"NetflixId present={'NetflixId=' in header}, "
          f"SecureNetflixId present={'SecureNetflixId=' in header}")
    print("-" * 70)
    with_res = probe("WITH cookies", header)
    print("-" * 70)
    without_res = probe("WITHOUT cookies (control)", None)
    print("-" * 70)
    if with_res is None:
        print("VERDICT: network error / blocked - inconclusive")
        return
    final = str(with_res.url)
    if "/login" in final or "signin" in final.replace("/", ""):
        print("VERDICT: DEAD - bounced to the login page even with cookies")
    elif with_res.status_code == 200 and str(without_res.url) != final:
        print("VERDICT: ALIVE - with-cookies request landed on an account page "
              "while the control was redirected to login")
    elif with_res.status_code == 403 or "not available" in with_res.text.lower():
        print("VERDICT: INCONCLUSIVE - Netflix edge blocked the datacenter IP")
    else:
        print(f"VERDICT: check markers above (final={final})")


if __name__ == "__main__":
    main()
