#!/usr/bin/env python3
"""Unit tests for autonomous_work_settings.py.

Covers the pure parsing/coercion logic and template rendering. Does not test
`install_launch_agent` or `_run_launchctl` — those spawn a real `launchctl`
and belong with the more end-to-end coverage in test-usage-host.py, which
already redirects them into a temp directory.

Loaded via a distinct module name (rather than a plain `import
autonomous_work_settings`) so this file's SETTINGS_FILE override can never be
shadowed by another test module that imported the real module name first —
each test file gets its own fresh copy, independent of run order.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIRECTORY = Path(__file__).resolve().parent.parent

_TEMP_DIRECTORY = tempfile.TemporaryDirectory()
_TEMP_PATH = Path(_TEMP_DIRECTORY.name)

os.environ.update(
    {
        "AUTONOMOUS_WORK_SETTINGS_FILE": str(_TEMP_PATH / "autonomous-work-settings.json"),
        "AUTONOMOUS_WORK_LAUNCH_AGENT_PLIST": str(_TEMP_PATH / "nightly.plist"),
        "AUTONOMOUS_WORK_ON_DEMAND_LAUNCH_AGENT_PLIST": str(_TEMP_PATH / "ondemand.plist"),
        "AUTONOMOUS_WORK_LAUNCHCTL": str(_TEMP_PATH / "launchctl-should-not-be-called"),
    }
)


def _load_module_under_test():
    module_path = SCRIPT_DIRECTORY / "autonomous_work_settings.py"
    spec = importlib.util.spec_from_file_location("autonomous_work_settings_under_test", module_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


settings_module = _load_module_under_test()


class ParseSettingsTests(unittest.TestCase):
    def test_non_dict_returns_defaults(self):
        self.assertEqual(settings_module.parse_settings(None), settings_module.DEFAULT_SETTINGS)
        self.assertEqual(settings_module.parse_settings("not a dict"), settings_module.DEFAULT_SETTINGS)
        self.assertEqual(settings_module.parse_settings([1, 2, 3]), settings_module.DEFAULT_SETTINGS)

    def test_empty_dict_returns_defaults(self):
        self.assertEqual(settings_module.parse_settings({}), settings_module.DEFAULT_SETTINGS)

    def test_valid_fields_are_used(self):
        result = settings_module.parse_settings(
            {
                "scheduleHour": 3,
                "scheduleMinute": 45,
                "newProjectsDirectory": "~/code/projects",
                "model": "sonnet",
                "maxPromptDurationHours": 2.5,
                "appendToAllPrompts": "Keep changes small.",
                "paceThresholdHours": -2.5,
                "resumeAfterFiveHourResetEnabled": False,
                "queueSource": "jira",
                "jiraProjectKey": "fcp",
                "jiraStatusNames": {"todo": "Next up"},
                "repositories": [{"name": "usage-optimizer", "path": "~/code/current/cuo"}],
            }
        )
        self.assertEqual(result.schedule_hour, 3)
        self.assertEqual(result.schedule_minute, 45)
        self.assertEqual(result.new_projects_directory, "~/code/projects")
        self.assertEqual(result.model, "sonnet")
        self.assertEqual(result.max_prompt_duration_hours, 2.5)
        self.assertEqual(result.append_to_all_prompts, "Keep changes small.")
        self.assertEqual(result.pace_threshold_hours, -2.5)
        self.assertFalse(result.resume_after_five_hour_reset_enabled)
        self.assertEqual(result.queue_source, "jira")
        # Upper-cased: Jira project keys are, and a lower-cased one in the
        # settings screen would otherwise build a JQL query that matches nothing.
        self.assertEqual(result.jira_project_key, "FCP")
        self.assertEqual(result.jira_status_names, {"todo": "Next up"})
        self.assertEqual(
            result.repositories,
            [{"name": "usage-optimizer", "path": "~/code/current/cuo"}],
        )

    def test_an_unknown_queue_source_falls_back_to_the_file(self):
        # The fallback direction that matters: no upgrade path may leave an
        # install with no queue at all.
        result = settings_module.parse_settings({"queueSource": "postgres"})
        self.assertEqual(result.queue_source, settings_module.QUEUE_SOURCE_FILE)

    def test_a_missing_queue_source_is_the_file(self):
        self.assertEqual(
            settings_module.parse_settings({}).queue_source, settings_module.QUEUE_SOURCE_FILE
        )

    def test_blank_and_non_string_status_names_are_dropped(self):
        result = settings_module.parse_settings(
            {"jiraStatusNames": {"todo": "  ", "inReview": 3, "done": " Shipped "}}
        )
        self.assertEqual(result.jira_status_names, {"done": "Shipped"})

    def test_a_non_dict_status_names_field_is_ignored(self):
        self.assertEqual(settings_module.parse_settings({"jiraStatusNames": "Done"}).jira_status_names, {})

    def test_repositories_default_to_an_empty_list(self):
        self.assertEqual(settings_module.parse_settings({}).repositories, [])

    def test_wrongly_shaped_repositories_are_dropped_one_by_one(self):
        # A member is dropped rather than the whole list rejected, the same
        # tolerance `jiraStatusNames` gets: one bad row must not cost the rest.
        result = settings_module.parse_settings(
            {
                "repositories": [
                    {"name": " alpha ", "path": " ~/code/alpha "},
                    {"name": "  ", "path": "~/code/blank"},
                    {"path": "~/code/nameless"},
                    "not a dict",
                    {"name": 3, "path": "~/code/numeric"},
                ]
            }
        )
        self.assertEqual(result.repositories, [{"name": "alpha", "path": "~/code/alpha"}])

    def test_a_repository_with_no_path_is_kept_as_a_draft_row(self):
        # Half-filled is a draft, not an error — it simply resolves to no
        # repository, exactly as an unset field on a card does.
        result = settings_module.parse_settings({"repositories": [{"name": "alpha"}]})
        self.assertEqual(result.repositories, [{"name": "alpha", "path": ""}])

    def test_a_non_list_repositories_field_is_ignored(self):
        self.assertEqual(
            settings_module.parse_settings({"repositories": {"name": "alpha"}}).repositories, []
        )

    def test_out_of_range_hour_falls_back_to_default(self):
        result = settings_module.parse_settings({"scheduleHour": 24})
        self.assertEqual(result.schedule_hour, settings_module.DEFAULT_SCHEDULE_HOUR)

    def test_negative_minute_falls_back_to_default(self):
        result = settings_module.parse_settings({"scheduleMinute": -1})
        self.assertEqual(result.schedule_minute, settings_module.DEFAULT_SCHEDULE_MINUTE)

    def test_bool_is_not_treated_as_a_valid_hour(self):
        # bool is a subclass of int in Python — the coercion helper explicitly
        # rejects it rather than treating True/False as 1/0.
        result = settings_module.parse_settings({"scheduleHour": True})
        self.assertEqual(result.schedule_hour, settings_module.DEFAULT_SCHEDULE_HOUR)

    def test_non_numeric_hour_falls_back_to_default(self):
        result = settings_module.parse_settings({"scheduleHour": "3am"})
        self.assertEqual(result.schedule_hour, settings_module.DEFAULT_SCHEDULE_HOUR)

    def test_invalid_model_falls_back_to_default(self):
        result = settings_module.parse_settings({"model": "gpt-5"})
        self.assertEqual(result.model, settings_module.DEFAULT_MODEL)

    def test_a_stored_haiku_is_coerced_to_sonnet(self):
        # Haiku is no longer offered — auto permission mode does not support it.
        # An install that had it selected lands on the nearest still-valid model
        # rather than on DEFAULT_MODEL, which is the most expensive one.
        result = settings_module.parse_settings({"model": "haiku"})
        self.assertEqual(result.model, "sonnet")
        self.assertNotIn("haiku", settings_module.VALID_MODEL_NAMES)

    def test_blank_new_projects_directory_falls_back_to_default(self):
        result = settings_module.parse_settings({"newProjectsDirectory": "   "})
        self.assertEqual(result.new_projects_directory, settings_module.DEFAULT_NEW_PROJECTS_DIRECTORY)

    def test_zero_or_negative_max_prompt_duration_falls_back_to_default(self):
        self.assertEqual(
            settings_module.parse_settings({"maxPromptDurationHours": 0}).max_prompt_duration_hours,
            settings_module.DEFAULT_MAX_PROMPT_DURATION_HOURS,
        )
        self.assertEqual(
            settings_module.parse_settings({"maxPromptDurationHours": -5}).max_prompt_duration_hours,
            settings_module.DEFAULT_MAX_PROMPT_DURATION_HOURS,
        )

    def test_missing_append_to_all_prompts_falls_back_to_default(self):
        result = settings_module.parse_settings({})
        self.assertEqual(result.append_to_all_prompts, settings_module.DEFAULT_APPEND_TO_ALL_PROMPTS)

    def test_non_string_append_to_all_prompts_falls_back_to_default(self):
        result = settings_module.parse_settings({"appendToAllPrompts": 123})
        self.assertEqual(result.append_to_all_prompts, settings_module.DEFAULT_APPEND_TO_ALL_PROMPTS)

    def test_missing_pace_threshold_hours_falls_back_to_default(self):
        result = settings_module.parse_settings({})
        self.assertEqual(result.pace_threshold_hours, settings_module.DEFAULT_PACE_THRESHOLD_HOURS)

    def test_negative_pace_threshold_hours_is_used(self):
        # Unlike max prompt duration, negative (and zero) are meaningful here —
        # they must not be coerced back to the default.
        result = settings_module.parse_settings({"paceThresholdHours": -2})
        self.assertEqual(result.pace_threshold_hours, -2)

    def test_zero_pace_threshold_hours_is_used(self):
        result = settings_module.parse_settings({"paceThresholdHours": 0})
        self.assertEqual(result.pace_threshold_hours, 0)

    def test_non_numeric_pace_threshold_hours_falls_back_to_default(self):
        result = settings_module.parse_settings({"paceThresholdHours": "a lot"})
        self.assertEqual(result.pace_threshold_hours, settings_module.DEFAULT_PACE_THRESHOLD_HOURS)

    def test_bool_is_not_treated_as_a_valid_pace_threshold(self):
        result = settings_module.parse_settings({"paceThresholdHours": True})
        self.assertEqual(result.pace_threshold_hours, settings_module.DEFAULT_PACE_THRESHOLD_HOURS)

    def test_missing_resume_after_reset_defaults_to_on(self):
        self.assertTrue(
            settings_module.parse_settings({}).resume_after_five_hour_reset_enabled
        )
        self.assertEqual(
            settings_module.DEFAULT_RESUME_AFTER_FIVE_HOUR_RESET_ENABLED, True
        )

    def test_resume_after_reset_false_is_respected(self):
        self.assertFalse(
            settings_module.parse_settings(
                {"resumeAfterFiveHourResetEnabled": False}
            ).resume_after_five_hour_reset_enabled
        )

    def test_non_bool_resume_after_reset_falls_back_to_on(self):
        # A truthy int or the string "false" is more likely a serialisation slip
        # than a considered choice, and the safe direction is the default.
        for bad_value in (0, 1, "false", "true", None):
            result = settings_module.parse_settings(
                {"resumeAfterFiveHourResetEnabled": bad_value}
            )
            self.assertTrue(result.resume_after_five_hour_reset_enabled)


class AutonomousWorkSettingsTests(unittest.TestCase):
    def test_new_projects_path_expands_user(self):
        result = settings_module.AutonomousWorkSettings(new_projects_directory="~/code/foo")
        self.assertEqual(result.new_projects_path, Path(os.path.expanduser("~/code/foo")))

    def test_describe_schedule_is_zero_padded(self):
        result = settings_module.AutonomousWorkSettings(schedule_hour=2, schedule_minute=5)
        self.assertEqual(result.describe_schedule(), "02:05")


class RenderTemplateTests(unittest.TestCase):
    """Against the real, checked-in plist templates — deterministic, no subprocess."""

    def test_nightly_template_has_no_placeholders_left(self):
        settings = settings_module.AutonomousWorkSettings(schedule_hour=3, schedule_minute=15)
        rendered = settings_module.render_launch_agent_plist(settings)
        self.assertIn("<integer>3</integer>", rendered)
        self.assertIn("<integer>15</integer>", rendered)
        self.assertNotIn("__HOUR__", rendered)
        self.assertNotIn("__MINUTE__", rendered)
        self.assertNotIn("__PROJECT_ROOT__", rendered)

    def test_on_demand_template_has_no_placeholders_left(self):
        rendered = settings_module.render_on_demand_launch_agent_plist()
        self.assertNotIn("__HOME__", rendered)
        self.assertNotIn("__PROJECT_ROOT__", rendered)


class SettingsRoundTripTests(unittest.TestCase):
    """write_settings / read_settings against the temp file this module was loaded with."""

    def test_write_then_read_round_trips(self):
        settings = settings_module.AutonomousWorkSettings(
            schedule_hour=4,
            schedule_minute=30,
            new_projects_directory="~/code/nightly",
            model="sonnet",
            max_prompt_duration_hours=1.5,
            append_to_all_prompts="Keep changes small.",
            pace_threshold_hours=-3.5,
            resume_after_five_hour_reset_enabled=False,
            queue_source="jira",
            jira_project_key="FCP",
            jira_status_names={"todo": "Next up"},
            repositories=[{"name": "alpha", "path": "~/code/alpha"}],
        )
        settings_module.write_settings(settings)
        self.assertEqual(settings_module.read_settings(), settings)

    def test_read_settings_falls_back_to_defaults_when_file_missing(self):
        settings_module.SETTINGS_FILE.unlink(missing_ok=True)
        self.assertEqual(settings_module.read_settings(), settings_module.DEFAULT_SETTINGS)


if __name__ == "__main__":
    unittest.main()
