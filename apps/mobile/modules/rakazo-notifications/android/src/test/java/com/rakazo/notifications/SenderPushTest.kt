package com.rakazo.notifications

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class SenderPushTest {
  @Test
  fun `sender IDs preserve replacement within one account and isolate other owners`() {
    val id = SenderPush.notificationId("https://one.example.test", "family", "thread")
    assertEquals(id, SenderPush.notificationId("https://one.example.test", "family", "thread"))
    assertNotEquals(id, SenderPush.notificationId("https://one.example.test", "work", "thread"))
    assertNotEquals(id, SenderPush.notificationId("https://two.example.test", "family", "thread"))
    assertNotEquals(id, SenderPush.notificationId("https://one.example.test", "family", "other"))
    assertNotEquals("https://one.example.test:family:thread".hashCode(), id)
  }

  private fun push(kind: String = "message") = JSONObject(
    mapOf(
      "notificationTitle" to "Bot",
      "notificationBody" to "Reply preview",
      "botId" to "bot",
      "threadId" to "thread",
      "kind" to kind,
    )
  )

  @Test
  fun `a Rakazo push without a session is dropped instead of handed to Expo`() {
    assertEquals(
      PushDisposition.DROP,
      SenderPush.disposition(push(), activeAccount = true, hasSession = { false }, openThread = { false }, foreground = { false }),
    )
  }

  @Test
  fun `a push with a session posts`() {
    assertEquals(
      PushDisposition.POST,
      SenderPush.disposition(push(), activeAccount = true, hasSession = { true }, openThread = { false }, foreground = { false }),
    )
  }

  @Test
  fun `a message without the Rakazo push copy still goes to Expo without a session`() {
    assertEquals(
      PushDisposition.EXPO,
      SenderPush.disposition(JSONObject(mapOf("kind" to "other")), activeAccount = true, hasSession = { false }, openThread = { false }, foreground = { false }),
    )
  }

  @Test
  fun `a Rakazo push missing a title is dropped to avoid blank tray spam`() {
    assertEquals(
      PushDisposition.DROP,
      SenderPush.disposition(
        JSONObject(mapOf("notificationTitle" to "", "botId" to "bot", "threadId" to "thread", "kind" to "completion")),
        activeAccount = true,
        hasSession = { true },
        openThread = { false },
        foreground = { false },
      ),
    )
  }

  @Test
  fun `an open thread and finished foreground work stay quiet`() {
    assertEquals(
      PushDisposition.DROP,
      SenderPush.disposition(push(), activeAccount = true, hasSession = { true }, openThread = { true }, foreground = { false }),
    )
    assertEquals(
      PushDisposition.DROP,
      SenderPush.disposition(push("completion"), activeAccount = true, hasSession = { true }, openThread = { false }, foreground = { true }),
    )
    assertEquals(
      PushDisposition.POST,
      SenderPush.disposition(push("completion"), activeAccount = true, hasSession = { true }, openThread = { false }, foreground = { false }),
    )
  }

  @Test
  fun `another account or server stays visible while the same thread is open in foreground`() {
    for (kind in listOf("message", "completion")) {
      assertEquals(
        PushDisposition.POST,
        SenderPush.disposition(push(kind), activeAccount = false, hasSession = { true }, openThread = { true }, foreground = { true }),
      )
    }
  }
}
