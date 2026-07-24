"""Tests for the audio-enrichment matching logic.

Covers the three tiers of the waterfall:
  1. SoundCloud individual track   (cluster.search_soundcloud)
  2. SoundCloud DJ set — NTS       (enrich.get_nts_sc_set_url)
  2. SoundCloud DJ set — Lot Radio (enrich.get_lotradio_set_url)

All SoundCloud / NTS HTTP calls are mocked — these tests never hit the network.

Run:  python3 -m pytest pipeline/tests -q
"""

import io
import json

import pytest

import cluster
import enrich


# ─────────────────────────────────────────────
# HTTP mocking
# ─────────────────────────────────────────────

class _FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    """Matching tests shouldn't pay the pipeline's rate-limit sleeps."""
    monkeypatch.setattr(cluster.time, "sleep", lambda *_: None)
    monkeypatch.setattr(enrich.time, "sleep", lambda *_: None)


@pytest.fixture
def mock_http(monkeypatch):
    """Serve canned JSON per request, and record every URL requested."""
    calls = []

    def install(payloads):
        """payloads: list of dicts served in order, or a single dict for all calls."""

        def fake_urlopen(req, *args, **kwargs):
            url = req.full_url if hasattr(req, "full_url") else req
            calls.append(url)
            if isinstance(payloads, list):
                body = payloads[min(len(calls) - 1, len(payloads) - 1)]
            else:
                body = payloads
            return _FakeResponse(json.dumps(body).encode("utf-8"))

        monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
        return calls

    install.calls = calls
    return install


def sc_track(title, user="somebody", user_id=1, permalink="https://soundcloud.com/x/y"):
    return {
        "title": title,
        "user": {"username": user, "id": user_id},
        "permalink_url": permalink,
        "artwork_url": "https://i1.sndcdn.com/artworks-abc-large.jpg",
        "duration": 300000,
    }


def collection(*items):
    return {"collection": list(items)}


# ─────────────────────────────────────────────
# 1. Lot Radio set matching
# ─────────────────────────────────────────────

LOT_EP = "https://www.thelotradio.com/episode/some-episode-2024"


class TestLotRadioMatching:
    def test_rejects_set_by_a_different_dj(self, mock_http):
        """The generic name search ranks other DJs' sets first — those must lose."""
        mock_http(collection(
            sc_track(
                "Elena Colombi @ The Lot Radio 2024",
                user="thelotradio",
                permalink="https://soundcloud.com/thelotradio/elena-colombi-2024",
            ),
        ))
        assert enrich.get_lotradio_set_url(LOT_EP, "Or:la", "cid", {}) is None

    def test_accepts_set_whose_title_names_the_dj(self, mock_http):
        url = "https://soundcloud.com/thelotradio/orla-jan-2024"
        mock_http(collection(
            sc_track(
                "Elena Colombi @ The Lot Radio 2024",
                user="thelotradio",
                permalink="https://soundcloud.com/thelotradio/elena-colombi-2024",
            ),
            sc_track("Or:la @ The Lot Radio Jan 2024", user="thelotradio", permalink=url),
        ))
        assert enrich.get_lotradio_set_url(LOT_EP, "Or:la", "cid", {}) == url

    def test_dj_name_in_permalink_slug_counts(self, mock_http):
        """Some uploads have a bare title but a descriptive slug."""
        url = "https://soundcloud.com/thelotradio/dj-python-live-set"
        mock_http(collection(sc_track("Live Set", user="thelotradio", permalink=url)))
        assert enrich.get_lotradio_set_url(LOT_EP, "DJ Python", "cid", {}) == url

    def test_rejects_non_lotradio_upload_even_with_matching_name(self, mock_http):
        mock_http(collection(
            sc_track(
                "Or:la — Studio Mix",
                user="bootlegs",
                permalink="https://soundcloud.com/bootlegs/orla-studio-mix",
            ),
        ))
        assert enrich.get_lotradio_set_url(LOT_EP, "Or:la", "cid", {}) is None

    def test_refuses_to_guess_when_dj_name_is_missing(self, mock_http):
        """With no DJ name there's nothing to verify against — don't take the first hit."""
        mock_http(collection(
            sc_track(
                "Elena Colombi @ The Lot Radio",
                user="thelotradio",
                permalink="https://soundcloud.com/thelotradio/elena-colombi",
            ),
        ))
        assert enrich.get_lotradio_set_url(LOT_EP, "", "cid", {}) is None

    def test_result_is_cached_per_episode(self, mock_http):
        calls = mock_http(collection(
            sc_track(
                "Or:la @ The Lot Radio",
                user="thelotradio",
                permalink="https://soundcloud.com/thelotradio/orla",
            ),
        ))
        cache = {}
        first = enrich.get_lotradio_set_url(LOT_EP, "Or:la", "cid", cache)
        second = enrich.get_lotradio_set_url(LOT_EP, "Or:la", "cid", cache)
        assert first == second
        assert len(calls) == 1

    def test_network_failure_yields_no_match(self, monkeypatch):
        import urllib.error

        def boom(*a, **k):
            raise urllib.error.URLError("down")

        monkeypatch.setattr("urllib.request.urlopen", boom)
        assert enrich.get_lotradio_set_url(LOT_EP, "Or:la", "cid", {}) is None


class TestLotRadioPredicate:
    @pytest.mark.parametrize("dj", ["Or:la", "or:la", "OR:LA"])
    def test_dj_name_match_is_punctuation_and_case_insensitive(self, dj):
        item = sc_track(
            "Or:La @ The Lot Radio",
            user="thelotradio",
            permalink="https://soundcloud.com/thelotradio/orla-2024",
        )
        assert enrich.lotradio_set_matches(item, dj)

    def test_partial_dj_name_is_not_enough(self):
        item = sc_track(
            "Anthony Naples @ The Lot Radio",
            user="thelotradio",
            permalink="https://soundcloud.com/thelotradio/anthony-naples",
        )
        assert not enrich.lotradio_set_matches(item, "Anthony Parasole")


# ─────────────────────────────────────────────
# 2. NTS set matching (SC search fallback)
# ─────────────────────────────────────────────

NTS_EP = "https://www.nts.live/shows/soup-to-nuts/episodes/soup-to-nuts-14th-may-2024"


@pytest.fixture
def nts_accounts(monkeypatch):
    """Pretend the known NTS SoundCloud accounts resolved to these user ids."""
    monkeypatch.setattr(enrich, "NTS_SC_USER_IDS", {111, 222})
    return {111, 222}


class TestNtsSearchFallback:
    def test_links_to_the_correct_show(self, mock_http, nts_accounts):
        url = "https://soundcloud.com/nts-latest/soup-to-nuts-14th-may-2024"
        mock_http(collection(
            sc_track("Rinse FM Breakfast Show", user="rinse", user_id=999),
            sc_track("Soup To Nuts - 14th May 2024", user="NTS Latest",
                     user_id=111, permalink=url),
        ))
        assert enrich.get_nts_sc_set_url(NTS_EP, "cid", {}) == url

    def test_rejects_unrelated_show_on_an_nts_account(self, mock_http, nts_accounts):
        """Same uploader, wrong episode — the old code took this."""
        mock_http(collection(
            sc_track(
                "Rhythm Section - 2nd March 2024",
                user="NTS Latest", user_id=111,
                permalink="https://soundcloud.com/nts-latest/rhythm-section",
            ),
        ))
        assert enrich.get_nts_sc_set_url(NTS_EP, "cid", {}) is None

    def test_rejects_matching_title_from_a_non_nts_account(self, mock_http, nts_accounts):
        mock_http(collection(
            sc_track(
                "Soup To Nuts - 14th May 2024",
                user="ripper", user_id=999,
                permalink="https://soundcloud.com/ripper/soup-to-nuts",
            ),
        ))
        assert enrich.get_nts_sc_set_url(NTS_EP, "cid", {}) is None

    def test_query_is_built_from_the_mixcloud_slug_when_available(self, mock_http, nts_accounts):
        url = "https://soundcloud.com/nts-latest/the-do-you-remember-show"
        calls = mock_http(collection(
            sc_track("The Do You Remember Show", user="NTS 2023",
                     user_id=222, permalink=url),
        ))
        mc = "https://www.mixcloud.com/NTSRadio/the-do-you-remember-show-24th-november-2017/"
        assert enrich.get_nts_sc_set_url(NTS_EP, "cid", {}, mc) == url
        assert "do+you+remember+show" in calls[0]
        assert "2017" not in calls[0]  # date suffix stripped from the slug

    def test_unparseable_episode_url_makes_no_request(self, mock_http, nts_accounts):
        calls = mock_http(collection())
        assert enrich.get_nts_sc_set_url("https://example.com/whatever", "cid", {}) is None
        assert calls == []

    def test_result_is_cached_per_episode(self, mock_http, nts_accounts):
        calls = mock_http(collection(
            sc_track("Soup To Nuts - 14th May 2024", user="NTS Latest", user_id=111,
                     permalink="https://soundcloud.com/nts-latest/soup-to-nuts"),
        ))
        cache = {}
        enrich.get_nts_sc_set_url(NTS_EP, "cid", cache)
        enrich.get_nts_sc_set_url(NTS_EP, "cid", cache)
        assert len(calls) == 1


class TestNtsApiPath:
    """The preferred path: NTS's own API hands us the SC/Mixcloud URLs."""

    def test_extracts_soundcloud_and_mixcloud_urls(self, mock_http):
        mock_http({
            "mixcloud": "https://www.mixcloud.com/NTSRadio/soup-to-nuts/",
            "audio_sources": [
                {"url": "https://stream.nts.live/x.m3u8"},
                {"url": "https://soundcloud.com/nts-latest/soup-to-nuts?utm_source=x"},
            ],
        })
        urls = enrich.get_nts_episode_urls(NTS_EP, {})
        assert urls["soundcloud"] == "https://soundcloud.com/nts-latest/soup-to-nuts"
        assert urls["mixcloud"] == "https://www.mixcloud.com/NTSRadio/soup-to-nuts/"

    def test_missing_audio_sources_returns_empty_result(self, mock_http):
        mock_http({"mixcloud": None, "audio_sources": []})
        assert enrich.get_nts_episode_urls(NTS_EP, {}) == {
            "soundcloud": None, "mixcloud": None,
        }


class TestNtsPredicate:
    def test_tolerates_extra_words_in_the_set_title(self, nts_accounts):
        item = sc_track("Soup To Nuts w/ Shy One - 14th May 2024",
                        user="NTS Latest", user_id=111)
        assert enrich.nts_set_matches(item, "soup to nuts")

    def test_filler_words_alone_never_match(self, nts_accounts):
        item = sc_track("Rhythm Section", user="NTS Latest", user_id=111)
        assert not enrich.nts_set_matches(item, "w with the")


# ─────────────────────────────────────────────
# 3. Individual-track matching (tier 1)
# ─────────────────────────────────────────────

class TestTrackMatching:
    def test_short_acronym_title_does_not_match_a_substring(self, mock_http):
        """'M.O.M.' normalizes to 'mom' — it must not match 'Momentum'."""
        mock_http(collection(
            sc_track("Momentum", user="Skee Mask",
                     permalink="https://soundcloud.com/skeemask/momentum"),
        ))
        assert cluster.search_soundcloud("Skee Mask", "M.O.M.", "cid") is None

    def test_short_acronym_title_matches_as_an_isolated_token(self, mock_http):
        url = "https://soundcloud.com/skeemask/mom"
        mock_http(collection(sc_track("M.O.M.", user="Skee Mask", permalink=url)))
        result = cluster.search_soundcloud("Skee Mask", "M.O.M.", "cid")
        assert result["scTrackUrl"] == url

    def test_short_artist_token_does_not_match_a_substring(self, mock_http):
        mock_http(collection(
            sc_track("Nightdrive", user="Anemone",
                     permalink="https://soundcloud.com/anemone/nightdrive"),
        ))
        # 'Ane' must not be satisfied by 'Anemone'
        assert cluster.search_soundcloud("Ane", "Nightdrive", "cid") is None

    def test_happy_path_exact_match(self, mock_http):
        url = "https://soundcloud.com/floatingpoints/birth4000"
        mock_http(collection(sc_track("Birth4000", user="Floating Points", permalink=url)))
        result = cluster.search_soundcloud("Floating Points", "Birth4000", "cid")
        assert result["scTrackUrl"] == url
        assert result["artUrl"].endswith("-t500x500.jpg")
        assert result["scDuration"] == 300000

    def test_longer_tokens_still_match_as_substrings(self, mock_http):
        """Suffix variance ('remix' in 'remixes') must keep working."""
        url = "https://soundcloud.com/label/track-remixes"
        mock_http(collection(
            sc_track("Peaceful Life (Remixes)", user="Kelbin", permalink=url),
        ))
        result = cluster.search_soundcloud("Kelbin", "Peaceful Life Remix", "cid")
        assert result["scTrackUrl"] == url

    def test_retries_with_parentheticals_stripped(self, mock_http):
        url = "https://soundcloud.com/artist/track"
        calls = mock_http([
            collection(),  # full query finds nothing
            collection(sc_track("Sundial", user="Nabihah Iqbal", permalink=url)),
        ])
        result = cluster.search_soundcloud("Nabihah Iqbal", "Sundial (Extended Mix)", "cid")
        assert result["scTrackUrl"] == url
        assert len(calls) == 2

    def test_no_match_returns_none(self, mock_http):
        mock_http(collection(sc_track("Totally Different", user="Someone Else")))
        assert cluster.search_soundcloud("Floating Points", "Birth4000", "cid") is None


class TestTrackPredicate:
    def test_artist_may_come_from_the_uploader_name(self):
        item = sc_track("Birth4000", user="Floating Points")
        assert cluster.sc_track_matches(item, "floating points", "birth4000")

    def test_empty_query_never_matches(self):
        assert not cluster.sc_track_matches(sc_track("Anything"), "", "")
