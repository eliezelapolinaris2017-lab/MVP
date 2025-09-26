import React, { useEffect, useState } from "react";
import { View, Text, Button, TextInput, Alert, FlatList, TouchableOpacity, Linking, Platform, Image } from "react-native";
import * as AuthSession from "expo-auth-session";
import * as Contacts from "expo-contacts";
import Constants from "expo-constants";
import dayjs from "dayjs";
import axios from "axios";
import { Agenda } from "react-native-calendars";

// ====== CONFIGURACIÓN RÁPIDA ======
const EXTRA = (Constants.expoConfig as any)?.extra ?? {};
const APP_NAME = EXTRA.APP_NAME || "Mi Calendario";
const PRIMARY_COLOR = EXTRA.PRIMARY_COLOR || "#2E86DE";
const GOOGLE_CLIENT_ID_WEB = EXTRA.GOOGLE_CLIENT_ID_WEB || ""; // <-- PON AQUÍ TU CLIENT ID
const SCOPES = ["https://www.googleapis.com/auth/calendar"].join(" ");
const CAL_BASE = "https://www.googleapis.com/calendar/v3";
let ACCESS_TOKEN: string | null = null;

// ====== AUTH GOOGLE (MVP: Implicit Flow) ======
async function signInWithGoogle() {
  if (!GOOGLE_CLIENT_ID_WEB) throw new Error("Falta GOOGLE_CLIENT_ID_WEB en app.config.ts (extra)");
  const redirectUri = AuthSession.makeRedirectUri({ scheme: "mi-calendario" });

  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(GOOGLE_CLIENT_ID_WEB)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_type=token&scope=${encodeURIComponent(SCOPES)}&include_granted_scopes=true&prompt=consent`;

  const result = (await AuthSession.startAsync({ authUrl })) as any;
  if (result?.type === "success" && result.params?.access_token) {
    ACCESS_TOKEN = result.params.access_token;
    return;
  }
  throw new Error("Inicio de sesión cancelado o fallido");
}

function authHeader() {
  if (!ACCESS_TOKEN) throw new Error("No autenticado");
  return { Authorization: `Bearer ${ACCESS_TOKEN}` };
}

// ====== CALENDAR API ======
async function listEvents(timeMinISO: string, timeMaxISO: string) {
  const res = await axios.get(`${CAL_BASE}/calendars/primary/events`, {
    headers: authHeader(),
    params: { timeMin: timeMinISO, timeMax: timeMaxISO, singleEvents: true, orderBy: "startTime" }
  });
  return res.data.items || [];
}

async function createEvent(evt: { summary: string; startISO: string; endISO: string; location?: string }) {
  const res = await axios.post(
    `${CAL_BASE}/calendars/primary/events`,
    {
      summary: evt.summary,
      start: { dateTime: evt.startISO },
      end: { dateTime: evt.endISO },
      location: evt.location
    },
    { headers: { ...authHeader(), "Content-Type": "application/json" } }
  );
  return res.data; // trae htmlLink
}

// ====== WHATSAPP helpers ======
function buildWhatsAppText(p: { title: string; start: string; end: string; location?: string; link?: string }) {
  return `📅 *${p.title}*
🕒 ${p.start} - ${p.end}
📍 ${p.location || "—"}
${p.link ? `🔗 ${p.link}` : ""}`;
}

async function sendWhatsAppMessage(text: string, phone?: string) {
  const encoded = encodeURIComponent(text);
  const url = phone ? `whatsapp://send?phone=${phone}&text=${encoded}` : `whatsapp://send?text=${encoded}`;
  const canOpen = await Linking.canOpenURL("whatsapp://send");
  if (canOpen) return Linking.openURL(url);
  const web = phone ? `https://wa.me/${phone}?text=${encoded}` : `https://wa.me/?text=${encoded}`;
  return Linking.openURL(web);
}

// ====== UI PRINCIPAL (todo en un solo componente) ======
export default function App() {
  const [logged, setLogged] = useState(false);
  const [items, setItems] = useState<Record<string, any[]>>({});
  const [loadingEvents, setLoadingEvents] = useState(false);

  // Form crear evento
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(dayjs().format("YYYY-MM-DD"));
  const [start, setStart] = useState("10:00");
  const [end, setEnd] = useState("11:00");
  const [location, setLocation] = useState("");
  const [phone, setPhone] = useState("");

  // Contactos
  const [contactsCount, setContactsCount] = useState(0);

  async function handleLogin() {
    try {
      await signInWithGoogle();
      setLogged(true);
      await loadMonthEvents();
    } catch (e: any) {
      Alert.alert("Error", e?.message || "No se pudo iniciar sesión.");
    }
  }

  async function loadMonthEvents() {
    try {
      setLoadingEvents(true);
      const startISO = dayjs().startOf("month").toISOString();
      const endISO = dayjs().endOf("month").toISOString();
      const events = await listEvents(startISO, endISO);
      const map: Record<string, any[]> = {};
      events.forEach((e: any) => {
        const s = e?.start?.dateTime || e?.start?.date;
        const f = e?.end?.dateTime || e?.end?.date;
        const key = dayjs(s).format("YYYY-MM-DD");
        if (!map[key]) map[key] = [];
        map[key].push({
          name: e.summary || "(Sin título)",
          time: s && f ? `${dayjs(s).format("HH:mm")} - ${dayjs(f).format("HH:mm")}` : "Todo el día",
          raw: e
        });
      });
      setItems(map);
    } catch (e) {
      console.warn(e);
    } finally {
      setLoadingEvents(false);
    }
  }

  async function onCreateEvent() {
    if (!title.trim()) return Alert.alert("Falta título", "Ingresa un título.");
    try {
      const startISO = dayjs(`${date} ${start}`).toISOString();
      const endISO = dayjs(`${date} ${end}`).toISOString();
      const evt = await createEvent({ summary: title.trim(), startISO, endISO, location: location.trim() });

      const text = buildWhatsAppText({
        title: title.trim(),
        start: `${date} ${start}`,
        end: `${date} ${end}`,
        location: location.trim(),
        link: evt?.htmlLink
      });
      await sendWhatsAppMessage(text, phone || undefined);
      Alert.alert("Listo", "Evento creado y WhatsApp abierto.");
      setTitle("");
      await loadMonthEvents();
    } catch (e: any) {
      Alert.alert("Error", e?.message || "No se pudo crear el evento.");
    }
  }

  async function importContacts() {
    const { status } = await Contacts.requestPermissionsAsync();
    if (status !== "granted") return Alert.alert("Permiso", "Acceso a contactos denegado.");
    const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.PhoneNumbers] });
    setContactsCount(data.length);
    Alert.alert("Contactos", `Se cargaron ${data.length} contactos (solo local).`);
  }

  if (!logged) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
        <Image source={require("./assets/icon.png")} style={{ width: 72, height: 72, borderRadius: 12, marginBottom: 8 }} />
        <Text style={{ fontSize: 18, fontWeight: "700" }}>{APP_NAME}</Text>
        <Button title="Entrar con Google" onPress={handleLogin} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {/* Calendario (Agenda) */}
      <Agenda
        items={items}
        renderItem={(item: any) => (
          <View style={{ backgroundColor: "white", padding: 12, borderRadius: 10, marginRight: 10, borderWidth: 1, borderColor: "#eee" }}>
            <Text style={{ fontWeight: "700" }}>{item.name}</Text>
            <Text style={{ color: "#666" }}>{item.time}</Text>
          </View>
        )}
        showClosingKnob
      />

      {/* Crear evento + compartir */}
      <View style={{ padding: 12, borderTopWidth: 1, borderColor: "#eee", gap: 8 }}>
        <Text style={{ fontWeight: "700" }}>Nueva cita</Text>
        <TextInput placeholder="Título" value={title} onChangeText={setTitle} style={styles.input} />
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TextInput style={[styles.input, { flex: 1 }]} placeholder="Fecha YYYY-MM-DD" value={date} onChangeText={setDate} />
          <TextInput style={[styles.input, { width: 90 }]} placeholder="HH:mm" value={start} onChangeText={setStart} />
          <TextInput style={[styles.input, { width: 90 }]} placeholder="HH:mm" value={end} onChangeText={setEnd} />
        </View>
        <TextInput placeholder="Lugar (opcional)" value={location} onChangeText={setLocation} style={styles.input} />
        <TextInput placeholder="Teléfono (5491122334455, opcional)" value={phone} onChangeText={setPhone} keyboardType="number-pad" style={styles.input} />
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TouchableOpacity onPress={onCreateEvent} style={[styles.btn, { backgroundColor: PRIMARY_COLOR }]}>
            <Text style={{ color: "white", fontWeight: "700" }}>Crear + WhatsApp</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={importContacts} style={[styles.btn, { backgroundColor: "#444" }]}>
            <Text style={{ color: "white" }}>Importar contactos ({contactsCount})</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={loadMonthEvents} disabled={loadingEvents} style={[styles.btnOutline]}>
            <Text>{loadingEvents ? "Cargando…" : "Refrescar"}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = {
  input: {
    borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 10
  },
  btn: {
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, alignItems: "center", justifyContent: "center"
  },
  btnOutline: {
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#ddd"
  }
} as const;
