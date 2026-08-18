// ============================================================
// botClubs.js — AI / bot kulüpler (seyrek lig doldurma)
// ------------------------------------------------------------
// Bot kulüpler: users satırı yok; clubs.user_id yerine
// ayrı bot kaydı. Şema: clubs.user_id NOT NULL olduğu için
// migration 003 ile nullable yapıyoruz + is_bot flag.
//
//   const botClubs = require("./botClubs");
//   await botClubs.ensureLeagueFilled({ country: "Türkiye", division: 1, targetSize: 8 });
// ============================================================

const { query, withTransaction } = require("./db");
const leagueRepo = require("./repos/leagueRepo");
const crypto = require("crypto");

/** Ülkeye göre kulüp adı havuzu: cityWords + suffixes */
const CLUB_NAME_BY_COUNTRY = {
  Türkiye: {
    cities: ["Ankara","İzmir","Bursa","Konya","Trabzon","Adana","Antalya","Gaziantep","Kayseri","Samsun","Eskişehir","Malatya","Sivas","Denizli","Muğla","Manisa","Balıkesir","Sakarya","Hatay","Ordu"],
    suffixes: ["Spor","SK","FK","Belediyespor","Gençlikspor","Gücü","İdmanyurdu","Yıldızspor","Demirspor","Sanayispor"],
  },
  Almanya: {
    cities: ["München","Dortmund","Berlin","Hamburg","Köln","Stuttgart","Frankfurt","Leipzig","Bremen","Mönchengladbach","Hoffenheim","Freiburg","Augsburg","Mainz","Wolfsburg","Gelsenkirchen","Bochum","Heidenheim","Darmstadt","Kiel","Nürnberg","Hannover","Düsseldorf","Bielefeld"],
    suffixes: ["FC","SV","BV","SC","VfB","VfL","FSV","TSG"],
  },
  İngiltere: {
    cities: ["London","Manchester","Liverpool","Birmingham","Leeds","Newcastle","Sheffield","Bristol","Brighton","Leicester","Nottingham","Southampton","Norwich","Wolverhampton","Burnley","Watford","Reading","Ipswich","Hull","Derby","Coventry","Middlesbrough","Stoke","Sunderland"],
    suffixes: ["FC","United","City","Town","Athletic","Rovers","Wanderers","Albion"],
  },
  İspanya: {
    cities: ["Madrid","Barcelona","Sevilla","Valencia","Bilbao","Villarreal","San Sebastián","Betis","Vigo","Gijón","Zaragoza","Mallorca","Girona","Cádiz","Granada","Pamplona","Almería","Valladolid","Elche","Leganés","Oviedo","Santander","Las Palmas","Málaga"],
    suffixes: ["FC","CF","CD","UD","Atlético","Deportivo","Racing","Real"],
  },
  İtalya: {
    cities: ["Milano","Torino","Napoli","Roma","Firenze","Bologna","Genova","Palermo","Verona","Parma","Udine","Cagliari","Lecce","Sassuolo","Empoli","Salerno","Bergamo","Brescia","Pisa","Bari","Catania","Perugia","Modena","Spezia"],
    suffixes: ["FC","AC","US","Calcio","SSC","AS"],
  },
  Fransa: {
    cities: ["Paris","Marseille","Lyon","Lille","Nice","Monaco","Rennes","Lens","Nantes","Strasbourg","Montpellier","Toulouse","Reims","Brest","Lorient","Angers","Metz","Clermont","Auxerre","Troyes","Bordeaux","Saint-Étienne","Nancy","Dijon"],
    suffixes: ["FC","Olympique","Racing","Stade","AS","US","SCO"],
  },
  Portekiz: {
    cities: ["Lisboa","Porto","Braga","Guimarães","Coimbra","Setúbal","Faro","Aveiro","Funchal","Leiria","Viseu","Évora","Barcelos","Famalicão","Moreira","Chaves","Estoril","Arouca","Amadora","Funchal"],
    suffixes: ["FC","SC","CF","Sporting","CD"],
  },
  Hollanda: {
    cities: ["Amsterdam","Rotterdam","Eindhoven","Utrecht","Alkmaar","Enschede","Heerenveen","Groningen","Breda","Arnhem","Tilburg","Nijmegen","Zwolle","Den Haag","Emmen","Volendam","Sittard","Waalwijk","Almere","Kerkrade"],
    suffixes: ["FC","SV","VV","SC","AFC"],
  },
  Belçika: {
    cities: ["Anderlecht","Brugge","Gent","Antwerpen","Genk","Charleroi","Leuven","Mechelen","Kortrijk","Oostende","Sint-Truiden","Eupen","Waregem","Cercle","Standard","Mouscron","Westerlo","Beerschot","Lokeren","Seraing"],
    suffixes: ["FC","KV","KRC","RSC","SV"],
  },
  İskoçya: {
    cities: ["Glasgow","Edinburgh","Aberdeen","Dundee","Motherwell","Kilmarnock","Livingston","St Johnstone","Hibernian","Hearts","St Mirren","Ross County","Inverness","Falkirk","Dunfermline","Partick","Hamilton","Ayr","Raith","Queen's Park"],
    suffixes: ["FC","United","Athletic","Rovers"],
  },
  İrlanda: {
    cities: ["Dublin","Cork","Limerick","Galway","Waterford","Drogheda","Sligo","Shamrock","Bohemians","Shelbourne","Dundalk","Athlone","Bray","Longford","Wexford","Finn Harps","UCD","Cork City","St Patrick","Derry"],
    suffixes: ["FC","United","Rovers","Athletic"],
  },
  Galler: {
    cities: ["Cardiff","Swansea","Newport","Wrexham","Bangor","Llanelli","Barry","Pontypridd","Merthyr","Aberystwyth","Connah's Quay","The New Saints","Caernarfon","Bala","Penybont"],
    suffixes: ["FC","United","City","Athletic","Town"],
  },
  İsveç: {
    cities: ["Stockholm","Göteborg","Malmö","Norrköping","Helsingborg","Örebro","Sundsvall","Uppsala","Linköping","Västerås","Kalmar","Halmstad","Östersund","Djurgården","AIK","Hammarby","Elfsborg","Häcken","Sirius","Varberg"],
    suffixes: ["IF","FF","FK","BK","SK"],
  },
  Norveç: {
    cities: ["Oslo","Bergen","Trondheim","Stavanger","Tromsø","Kristiansand","Bodø","Molde","Fredrikstad","Haugesund","Sandefjord","Lillestrøm","Vålerenga","Rosenborg","Brann","Strømsgodset","Odd","Sarpsborg","Aalesund","Viking"],
    suffixes: ["FK","IF","BK","SK","IL"],
  },
  Danimarka: {
    cities: ["København","Aarhus","Odense","Aalborg","Esbjerg","Randers","Viborg","Horsens","Silkeborg","Midtjylland","Nordsjælland","Brøndby","Lyngby","SønderjyskE","Vejle","Hobro","Helsingør","Hvidovre","Fredericia","Kolding"],
    suffixes: ["FC","IF","BK","FF"],
  },
  İsviçre: {
    cities: ["Zürich","Basel","Bern","Genève","Lausanne","Luzern","St. Gallen","Thun","Sion","Lugano","Young Boys","Grasshopper","Servette","Winterthur","Aarau","Vaduz","Xamax","Schaffhausen","Yverdon","Wil"],
    suffixes: ["FC","SC","AC"],
  },
  Avusturya: {
    cities: ["Wien","Salzburg","Graz","Innsbruck","Linz","Klagenfurt","Wolfsberg","Ried","Lustenau","Mattersburg","Sturm","Rapid","Austria","Hartberg","Altach","Admira","Wacker","SV Ried","WSG"],
    suffixes: ["FC","SK","SC","SV","AK"],
  },
  Polonya: {
    cities: ["Warszawa","Kraków","Gdańsk","Poznań","Wrocław","Łódź","Katowice","Lublin","Białystok","Szczecin","Bydgoszcz","Gdynia","Częstochowa","Radom","Rzeszów","Kielce","Toruń","Gliwice","Zabrze","Legia"],
    suffixes: ["KS","FC","TS","RKS","GKS"],
  },
  Ukrayna: {
    cities: ["Kyiv","Kharkiv","Donetsk","Lviv","Odesa","Dnipro","Zaporizhzhia","Poltava","Mariupol","Kryvyi Rih","Vinnytsia","Chernihiv","Sumy","Zhytomyr","Mykolaiv","Kherson","Lutsk","Rivne","Ternopil","Uzhhorod"],
    suffixes: ["FC","FK","SK"],
  },
  Çekya: {
    cities: ["Praha","Brno","Ostrava","Plzeň","Liberec","Olomouc","Hradec Králové","Pardubice","České Budějovice","Jablonec","Zlín","Teplice","Karviná","Slavia","Sparta","Baník","Sigma","Bohemians","Dukla","Viktoria"],
    suffixes: ["FC","SK","FK","AC"],
  },
  Slovakya: {
    cities: ["Bratislava","Košice","Žilina","Prešov","Nitra","Trnava","Banská Bystrica","Trenčín","Martin","Poprad","Ružomberok","Dunajská Streda","Zlaté Moravce","Senica","Michalovce"],
    suffixes: ["FC","ŠK","FK","AS"],
  },
  Macaristan: {
    cities: ["Budapest","Debrecen","Szeged","Pécs","Győr","Miskolc","Nyíregyháza","Kecskemét","Szombathely","Veszprém","Honvéd","Ferencváros","Újpest","MTK","Videoton","Diósgyőr","Paksi","Zalaegerszeg","Haladás","Vasas"],
    suffixes: ["FC","TC","SE","SC"],
  },
  Romanya: {
    cities: ["București","Cluj","Timișoara","Iași","Constanța","Craiova","Galați","Brașov","Ploiești","Oradea","Sibiu","Arad","Bacău","Târgu Mureș","Steaua","Dinamo","CFR","Astra","Viitorul","Sepsi"],
    suffixes: ["FC","CFR","CS","AS"],
  },
  Bulgaristan: {
    cities: ["Sofia","Plovdiv","Varna","Burgas","Ruse","Stara Zagora","Pleven","Sliven","Dobrich","Shumen","CSKA","Levski","Ludogorets","Botev","Cherno More","Lokomotiv","Slavia","Beroe","Arda","Pirin"],
    suffixes: ["FC","PFK","FK"],
  },
  Yunanistan: {
    cities: ["Athina","Thessaloniki","Piraeus","Heraklion","Patras","Larissa","Volos","Ioannina","Kavala","Rhodes","Olympiacos","Panathinaikos","AEK","PAOK","Aris","Panionios","OFI","Asteras","Atromitos","PAS"],
    suffixes: ["FC","AEK","PAOK","AS"],
  },
  Hırvatistan: {
    cities: ["Zagreb","Split","Rijeka","Osijek","Zadar","Pula","Šibenik","Dubrovnik","Varaždin","Slavonski Brod","Dinamo","Hajduk","Lokomotiva","Istra","Gorica","Rudeš","Inter Zaprešić","Cibalia","Šibenik","Varaždin"],
    suffixes: ["NK","HNK","FC","FK"],
  },
  Sırbistan: {
    cities: ["Beograd","Novi Sad","Niš","Kragujevac","Subotica","Čačak","Zrenjanin","Pančevo","Kruševac","Užice","Crvena Zvezda","Partizan","Vojvodina","Radnički","Čukarički","TSC","Napredak","Spartak","Mladost","Javor"],
    suffixes: ["FK","OFK","FC"],
  },
  "Bosna-Hersek": {
    cities: ["Sarajevo","Banja Luka","Mostar","Tuzla","Zenica","Bijeljina","Prijedor","Bihać","Trebinje","Doboj","Željezničar","Velež","Široki Brijeg","Zrinjski","Borac","Sloboda","Olimpik","Rudar","TOŠK"],
    suffixes: ["FK","NK","FC"],
  },
  Arnavutluk: {
    cities: ["Tirana","Durrës","Vlorë","Shkodër","Elbasan","Fier","Korçë","Berat","Lushnjë","Kavajë","Partizani","Dinamo","Vllaznia","Skënderbeu","Teuta","Flamurtari","Laçi","Kukësi","Bylis"],
    suffixes: ["KF","FK","FC"],
  },
  Slovenya: {
    cities: ["Ljubljana","Maribor","Celje","Koper","Nova Gorica","Domžale","Murska Sobota","Kranj","Ptuj","Novo Mesto","Olimpija","Maribor","Celje","Mura","Bravo","Tabor","Aluminij","Rudar"],
    suffixes: ["NK","FC","ND"],
  },
  Rusya: {
    cities: ["Moskva","Sankt-Peterburg","Kazan","Samara","Rostov","Krasnodar","Sochi","Nizhny Novgorod","Yekaterinburg","Ufa","Zenit","Spartak","CSKA","Lokomotiv","Rubin","Dynamo","Akhmat","Krylia","Ural","Fakel"],
    suffixes: ["FC","FK","PFK"],
  },
  Finlandiya: {
    cities: ["Helsinki","Espoo","Tampere","Turku","Oulu","Jyväskylä","Lahti","Kuopio","Pori","Kouvola","HJK","Inter","Ilves","SJK","KuPS","Mariehamn","VPS","HIFK","Honka"],
    suffixes: ["FC","JK","SC","IF"],
  },
  Brezilya: {
    cities: ["São Paulo","Rio","Belo Horizonte","Porto Alegre","Salvador","Recife","Fortaleza","Curitiba","Campinas","Goiânia","Santos","Flamengo","Corinthians","Palmeiras","Grêmio","Internacional","Cruzeiro","Atlético","Botafogo","Vasco"],
    suffixes: ["FC","SC","EC","AC"],
  },
  Arjantin: {
    cities: ["Buenos Aires","Rosario","Córdoba","La Plata","Mendoza","Mar del Plata","Tucumán","Salta","Santa Fe","Bahía Blanca","Boca","River","Racing","Independiente","San Lorenzo","Newell's","Estudiantes","Vélez","Huracán","Lanús"],
    suffixes: ["FC","CA","Club"],
  },
  Uruguay: {
    cities: ["Montevideo","Salto","Paysandú","Las Piedras","Rivera","Maldonado","Tacuarembó","Melo","Artigas","Durazno","Peñarol","Nacional","Defensor","Danubio","Wanderers","Liverpool","Cerro","Racing","Fénix"],
    suffixes: ["FC","CA","Club"],
  },
  Şili: {
    cities: ["Santiago","Valparaíso","Concepción","Antofagasta","Temuco","La Serena","Viña del Mar","Rancagua","Talca","Iquique","Colo-Colo","Universidad de Chile","Universidad Católica","Audax","Everton","Huachipato","Cobresal","Palestino","Unión Española"],
    suffixes: ["FC","CD","Club"],
  },
  Kolombiya: {
    cities: ["Bogotá","Medellín","Cali","Barranquilla","Cartagena","Bucaramanga","Cúcuta","Pereira","Manizales","Ibagué","Millonarios","Nacional","América","Junior","Santa Fe","Tolima","Once Caldas","Deportivo Cali","Envigado"],
    suffixes: ["FC","CD","SC"],
  },
  Ekvador: {
    cities: ["Quito","Guayaquil","Cuenca","Ambato","Manta","Portoviejo","Machala","Santo Domingo","Ibarra","Riobamba","Barcelona","Emelec","LDU","Independiente","Aucas","Delfín","Universidad Católica","Mushuc Runa"],
    suffixes: ["FC","SC","CD"],
  },
  Peru: {
    cities: ["Lima","Arequipa","Trujillo","Cusco","Piura","Chiclayo","Iquitos","Huancayo","Tacna","Callao","Alianza","Universitario","Sporting Cristal","Melgar","Cienciano","Sport Boys","UTC","Ayacucho","Binacional"],
    suffixes: ["FC","Club","Deportivo"],
  },
  Paraguay: {
    cities: ["Asunción","Ciudad del Este","Encarnación","Luque","San Lorenzo","Capiatá","Lambaré","Fernando de la Mora","Coronel Oviedo","Pedro Juan Caballero","Olimpia","Cerro Porteño","Libertad","Guaraní","Nacional","Sol de América","Luqueño"],
    suffixes: ["FC","Club","Deportivo"],
  },
  Venezuela: {
    cities: ["Caracas","Maracaibo","Valencia","Barquisimeto","Maracay","Ciudad Guayana","Barcelona","Maturín","San Cristóbal","Mérida","Caracas FC","Deportivo Táchira","Zamora","Estudiantes","Monagas","La Guaira","Mineros"],
    suffixes: ["FC","Club","Deportivo"],
  },
  Meksika: {
    cities: ["Ciudad de México","Guadalajara","Monterrey","Puebla","Tijuana","León","Toluca","Querétaro","Santos","Pachuca","América","Chivas","Tigres","Cruz Azul","Pumas","Atlas","Necaxa","Mazatlán","Juárez"],
    suffixes: ["FC","CF","Club"],
  },
  ABD: {
    cities: ["New York","Los Angeles","Chicago","Houston","Dallas","Atlanta","Seattle","Portland","Columbus","Philadelphia","Kansas City","Salt Lake","Orlando","Miami","Nashville","Austin","Cincinnati","Charlotte","Minnesota","Colorado"],
    suffixes: ["FC","United","SC","City"],
  },
  Kanada: {
    cities: ["Toronto","Montreal","Vancouver","Calgary","Edmonton","Ottawa","Winnipeg","Halifax","Victoria","Hamilton","Forge","Cavalry","Pacific","York","Valour","HFX","Atlético Ottawa"],
    suffixes: ["FC","United","SC"],
  },
  "Costa Rica": {
    cities: ["San José","Alajuela","Cartago","Heredia","Puntarenas","Limón","Liberia","Pérez Zeledón","Desamparados","Curridabat","Saprissa","Alajuelense","Herediano","Cartaginés","Santos","Guadalupe"],
    suffixes: ["FC","Deportivo","CS"],
  },
  Jamaika: {
    cities: ["Kingston","Montego Bay","Spanish Town","Portmore","May Pen","Mandeville","Ocho Rios","Negril","Half Way Tree","St Ann","Arnett Gardens","Harbour View","Waterhouse","Tivoli","Portmore United","Cavalier"],
    suffixes: ["FC","United","SC"],
  },
  Japonya: {
    cities: ["Tokyo","Osaka","Yokohama","Nagoya","Sapporo","Kobe","Fukuoka","Hiroshima","Sendai","Kawasaki","Urawa","Kashima","Gamba","Cerezo","Sanfrecce","Vissel","Shimizu","Júbilo","Consadole","Frontale"],
    suffixes: ["FC","SC","United"],
  },
  "Güney Kore": {
    cities: ["Seoul","Busan","Incheon","Daegu","Daejeon","Gwangju","Ulsan","Suwon","Jeonju","Jeju","Pohang","Seongnam","Jeonbuk","Gangwon","Suwon Samsung","FC Seoul","Ulsan Hyundai"],
    suffixes: ["FC","United","SC"],
  },
  Çin: {
    cities: ["Beijing","Shanghai","Guangzhou","Shenzhen","Chengdu","Wuhan","Tianjin","Chongqing","Hangzhou","Nanjing","Shandong","Henan","Dalian","Changchun","Qingdao","Jiangsu","Beijing Guoan"],
    suffixes: ["FC","United"],
  },
  Avustralya: {
    cities: ["Sydney","Melbourne","Brisbane","Perth","Adelaide","Newcastle","Wellington","Canberra","Hobart","Gold Coast","Western Sydney","Central Coast","Macarthur","Western United"],
    suffixes: ["FC","United","City"],
  },
  "Suudi Arabistan": {
    cities: ["Riyadh","Jeddah","Dammam","Mecca","Medina","Khobar","Tabuk","Abha","Taif","Buraidah","Al Hilal","Al Nassr","Al Ittihad","Al Ahli","Al Shabab","Al Fateh","Al Taawoun","Al Ettifaq"],
    suffixes: ["FC","SC","Club"],
  },
  İran: {
    cities: ["Tehran","Isfahan","Tabriz","Mashhad","Shiraz","Ahvaz","Karaj","Qom","Kermanshah","Rasht","Persepolis","Esteghlal","Sepahan","Tractor","Foolad","Zob Ahan","Naft","Mes"],
    suffixes: ["FC","SC"],
  },
  Katar: {
    cities: ["Doha","Al Rayyan","Al Wakrah","Al Khor","Umm Salal","Al Sailiya","Lusail","Al Gharafa","Al Duhail","Al Sadd","Qatar SC","Al Arabi","Al Ahli","Al Markhiya"],
    suffixes: ["SC","FC","Club"],
  },
  Hindistan: {
    cities: ["Mumbai","Kolkata","Delhi","Bengaluru","Chennai","Goa","Hyderabad","Kochi","Pune","Ahmedabad","Kerala","Jamshedpur","Odisha","Northeast","Mohun Bagan","East Bengal","ATK"],
    suffixes: ["FC","United","SC"],
  },
  Mısır: {
    cities: ["Kahire","İskenderiye","Gize","Port Said","Suez","Mansoura","Tanta","Asyut","Ismailia","Luxor","Al Ahly","Zamalek","Pyramids","Ismaily","Al Masry","ENPPI","Smouha","El Gouna"],
    suffixes: ["FC","SC","Club"],
  },
  Fas: {
    cities: ["Casablanca","Rabat","Fès","Marrakech","Tangier","Agadir","Meknès","Oujda","Kenitra","Tétouan","Wydad","Raja","FAR","RS Berkane","Maghreb","Hassania","Olympic Safi","Ittihad"],
    suffixes: ["FC","SC","AS"],
  },
  Nijerya: {
    cities: ["Lagos","Abuja","Kano","Ibadan","Port Harcourt","Benin City","Kaduna","Enugu","Jos","Calabar","Enyimba","Rangers","Shooting Stars","Kano Pillars","Rivers United","Akwa United","Plateau United"],
    suffixes: ["FC","United","SC"],
  },
  Senegal: {
    cities: ["Dakar","Thiès","Saint-Louis","Kaolack","Ziguinchor","Touba","Mbour","Rufisque","Diourbel","Louga","Génération Foot","Jaraaf","Casa Sports","Teungueth","Diambars","ASC Niarry Tally"],
    suffixes: ["FC","ASC","SC"],
  },
  Gana: {
    cities: ["Accra","Kumasi","Tamale","Takoradi","Cape Coast","Tema","Obuasi","Koforidua","Sunyani","Ho","Hearts of Oak","Asante Kotoko","Ashanti Gold","Aduana","Medeama","Bechem United"],
    suffixes: ["FC","SC","United"],
  },
  Kamerun: {
    cities: ["Yaoundé","Douala","Garoua","Bamenda","Bafoussam","Maroua","Ngaoundéré","Bertoua","Loum","Kumba","Canon","Union Douala","Coton Sport","Aigle Royal","Bamboutos","Yong Sports"],
    suffixes: ["FC","SC","United"],
  },
  "Fildişi Sahili": {
    cities: ["Abidjan","Bouaké","Yamoussoukro","San-Pédro","Daloa","Korhogo","Man","Gagnoa","Abengourou","Divo","ASEC","Africa Sports","Stade d'Abidjan","SOA","Racing Club","AFAD"],
    suffixes: ["FC","SC","ASC"],
  },
  Cezayir: {
    cities: ["Cezayir","Oran","Constantine","Annaba","Blida","Batna","Sétif","Tlemcen","Béjaïa","Skikda","MC Alger","USM Alger","JS Kabylie","CR Belouizdad","ES Sétif","MC Oran","CS Constantine"],
    suffixes: ["FC","US","MC","JS"],
  },
  Tunus: {
    cities: ["Tunus","Sfax","Sousse","Kairouan","Bizerte","Gabès","Ariana","Gafsa","Monastir","Ben Arous","Espérance","Club Africain","Étoile du Sahel","CS Sfaxien","CA Bizertin","Stade Tunisien"],
    suffixes: ["FC","ES","CA","CS"],
  },
  "Güney Afrika": {
    cities: ["Johannesburg","Cape Town","Durban","Pretoria","Port Elizabeth","Bloemfontein","Polokwane","Nelspruit","East London","Kimberley","Kaizer Chiefs","Orlando Pirates","Mamelodi Sundowns","SuperSport","AmaZulu","Stellenbosch","Cape Town City"],
    suffixes: ["FC","United","AFC"],
  },
};

const DEFAULT_CLUB_POOL = CLUB_NAME_BY_COUNTRY["Türkiye"];

const POSITIONS_18 = [
  "GK", "DL", "DC", "DC", "DR", "DM", "MC", "MC", "OMC", "FL", "FR",
  "GK", "DC", "MC", "FC", "ML", "MR", "DM",
];

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

/**
 * Ülkeye uygun bot kulüp ismi üret.
 * opts.country + opts.index → deterministik, ligler tutarlı isim alır.
 */
function randomName(used, opts = {}) {
  const set = used instanceof Set ? used : new Set();
  let country = opts.country || "Türkiye";
  try {
    const { normalizeCountry } = require("./countries");
    country = normalizeCountry(country) || country;
  } catch (_) {}
  const pool = CLUB_NAME_BY_COUNTRY[country] || DEFAULT_CLUB_POOL;
  const cities = pool.cities || DEFAULT_CLUB_POOL.cities;
  const suffixes = pool.suffixes || DEFAULT_CLUB_POOL.suffixes;
  const idx =
    opts.index != null && Number.isFinite(Number(opts.index))
      ? Math.abs(Number(opts.index))
      : null;

  function buildName(city, suffix) {
    // Şehir zaten kulüp adı gibiyse (Flamengo, Zenit, Al Hilal vb.) tek başına kullan
    const looksLikeClub =
      /\s/.test(city) ||
      /^(FC|SC|AC|AS|CF|CD|FK|NK|HNK|KF|PFK|RSC|KRC|KV|SV|BV|Vf[BL]|TSG|FSV|IF|FF|BK|SK|JK|SE|TC|US|MC|JS|CA|ES|CS|ASC|AFC)\b/i.test(city) ||
      /\b(United|City|Athletic|Rovers|Wanderers|Albion|Olympique|Racing|Stade|Sporting|Calcio|Deportivo|Atlético|Real)\b/i.test(city) ||
      city.length > 12;
    if (looksLikeClub) return city;
    return city + " " + suffix;
  }

  if (idx != null) {
    const total = cities.length * suffixes.length;
    for (let k = 0; k < total; k++) {
      const city = cities[(idx + k) % cities.length];
      const suffix = suffixes[Math.floor((idx + k) / cities.length) % suffixes.length];
      const n = buildName(city, suffix);
      if (!set.has(n.toLowerCase())) return n;
    }
  }

  for (let i = 0; i < 50; i++) {
    const city = cities[Math.floor(Math.random() * cities.length)];
    const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
    const n = buildName(city, suffix);
    if (!set.has(n.toLowerCase())) return n;
  }
  return (cities[0] || "Bot") + " FC " + Math.floor(Math.random() * 900 + 100);
}

function skillBase(strength) {
  // strength 1–10 → tipik ortalama ~6.5–12 (herkese yüksek skill yok)
  return 5.2 + strength * 0.55 + Math.random() * 1.4;
}

/** Mevkiye göre skill ağırlıkları (ana roller yüksek, diğerleri mantıklı düşük) */
function posSkillMods(pos) {
  const p = String(pos || "").toUpperCase();
  // sıra: pace,passing,finishing,tackle,vision,stamina,strength,technique,agility,positioning,reflex,handling
  const table = {
    GK:  { pace: -2.2, passing: -0.8, finishing: -4.0, tackle: -2.0, vision: -0.6, stamina: -0.5, strength: 0.4, technique: -2.8, agility: 1.2, positioning: 2.2, reflex: 4.2, handling: 4.0 },
    DC:  { pace: -0.8, passing: -0.6, finishing: -2.8, tackle: 3.2, vision: -0.8, stamina: 1.0, strength: 2.4, technique: -0.6, agility: -0.6, positioning: 3.0, reflex: -3.0, handling: -4.0 },
    DL:  { pace: 1.4, passing: 0.2, finishing: -2.2, tackle: 2.2, vision: -0.4, stamina: 1.2, strength: 0.6, technique: 0.2, agility: 1.0, positioning: 1.8, reflex: -3.0, handling: -4.0 },
    DR:  { pace: 1.4, passing: 0.2, finishing: -2.2, tackle: 2.2, vision: -0.4, stamina: 1.2, strength: 0.6, technique: 0.2, agility: 1.0, positioning: 1.8, reflex: -3.0, handling: -4.0 },
    DM:  { pace: -0.4, passing: 1.4, finishing: -2.0, tackle: 2.4, vision: 0.8, stamina: 1.6, strength: 1.2, technique: 0.4, agility: -0.2, positioning: 1.6, reflex: -3.0, handling: -4.0 },
    MC:  { pace: 0.2, passing: 2.4, finishing: -0.8, tackle: 0.6, vision: 2.2, stamina: 1.4, strength: 0.2, technique: 1.6, agility: 0.4, positioning: 0.8, reflex: -3.0, handling: -4.0 },
    ML:  { pace: 1.8, passing: 1.2, finishing: 0.2, tackle: -0.6, vision: 0.8, stamina: 1.2, strength: -0.4, technique: 1.4, agility: 1.6, positioning: 0.2, reflex: -3.0, handling: -4.0 },
    MR:  { pace: 1.8, passing: 1.2, finishing: 0.2, tackle: -0.6, vision: 0.8, stamina: 1.2, strength: -0.4, technique: 1.4, agility: 1.6, positioning: 0.2, reflex: -3.0, handling: -4.0 },
    OMC: { pace: 0.4, passing: 2.6, finishing: 1.2, tackle: -1.2, vision: 2.8, stamina: 0.6, strength: -0.4, technique: 2.2, agility: 0.8, positioning: 0.6, reflex: -3.0, handling: -4.0 },
    FL:  { pace: 2.4, passing: 0.6, finishing: 1.6, tackle: -1.6, vision: 0.4, stamina: 0.8, strength: -0.6, technique: 1.6, agility: 2.2, positioning: 0.2, reflex: -3.0, handling: -4.0 },
    FR:  { pace: 2.4, passing: 0.6, finishing: 1.6, tackle: -1.6, vision: 0.4, stamina: 0.8, strength: -0.6, technique: 1.6, agility: 2.2, positioning: 0.2, reflex: -3.0, handling: -4.0 },
    FC:  { pace: 0.8, passing: -0.4, finishing: 3.4, tackle: -2.0, vision: 0.2, stamina: 0.8, strength: 1.8, technique: 1.4, agility: 0.6, positioning: 1.6, reflex: -3.0, handling: -4.0 },
  };
  return table[p] || table.MC;
}

function clampSkill(v) {
  // 4–17 arası; süperstar yağmuru yok
  return Math.max(4, Math.min(17, Math.round(v * 10) / 10));
}

function makePlayer(clubId, pos, idx, strength) {
  const base = skillBase(strength);
  const mods = posSkillMods(pos);
  // Birincil roller biraz daha tutarlı, ikinciller daha dağınık
  function sk(mod, primary) {
    const spread = primary ? 1.6 : 2.4;
    return clampSkill(base + mod + (Math.random() - 0.5) * spread);
  }
  const first = [
    "Ali", "Mehmet", "Ahmet", "Mustafa", "Hasan", "Hüseyin", "İbrahim",
    "Yusuf", "Ömer", "Murat", "Serkan", "Tolga", "Cem", "Barış", "Onur",
    "Emre", "Can", "Burak", "Kerem", "Arda", "Berkay", "Volkan", "Kaan",
    "Mert", "Furkan", "Deniz", "Alp", "Yiğit", "Efe", "Umut", "Gökhan",
    "Selim", "Taner", "Baran", "Enes", "Uğur", "Erhan", "Sinan",
    "Metehan", "Kağan", "Bora", "Eren", "Kenan", "Bahadır", "Tayfun",
    "Oğuzhan", "Görkem", "İlker", "Rıdvan", "Semih", "Doruk", "Berkan",
    "Cenk", "Ozan", "Hakan", "Çağatay", "Tuna", "Batuhan", "Koray",
    "Levent", "Alper", "Faruk", "Salih", "Vedat", "Zafer", "Metin",
    "Atakan", "Emir", "Ferhat", "Harun", "İdris", "Kuzey", "Okan",
    "Samet", "Utku", "Yavuz", "Zeki", "Berke", "Ege", "Fırat", "Sarp",
    "Taha", "Poyraz", "Rüzgar", "Çınar", "Alparslan", "Abdullah", "Adem",
    "Anıl", "Berk", "Bilal", "Cengiz", "Doğan", "Erdem", "Erkan", "Fatih",
    "Hamza", "İlyas", "Kadir", "Kemal", "Mahmut", "Mesut", "Oğuz", "Özgür",
    "Lucas", "Gabriel", "James", "Harry", "Marco", "Luca", "Carlos", "Diego",
    "Hugo", "Paul", "Kai", "Leon", "Jonas", "Felix", "Santiago", "Mateo",
  ];
  const last = [
    "Yılmaz", "Kaya", "Demir", "Şahin", "Çelik", "Aydın", "Öztürk",
    "Arslan", "Doğan", "Kılıç", "Aslan", "Koç", "Polat", "Kurt", "Yıldız",
    "Özdemir", "Çetin", "Aksoy", "Bulut", "Sarı", "Yavuz", "Erdoğan",
    "Güneş", "Korkmaz", "Kaplan", "Türk", "Avcı", "Yıldırım", "Aktaş",
    "Öz", "Karaca", "Tunç", "Uçar", "Bozkurt", "Aygün", "Çakır", "Duman",
    "Ergin", "Tekin", "Yalçın", "Şimşek", "Acar", "Akın", "Ateş", "Bayram",
    "Can", "Çakmak", "Durmuş", "Ekici", "Gezer", "Güler", "Işık", "Kara",
    "Kartal", "Keskin", "Köse", "Mutlu", "Özer", "Sağlam", "Sezer", "Soylu",
    "Taş", "Toprak", "Tuna", "Uysal", "Ünal", "Yaman", "Yiğit", "Zengin",
    "Akbulut", "Akgün", "Altın", "Atalay", "Bakır", "Bayraktar", "Ceylan",
    "Dağ", "Ekinci", "Gökçe", "Karadağ", "Özbay", "Pektaş", "Solak", "Tan",
    "Silva", "Santos", "García", "Fernández", "Smith", "Jones", "Müller",
    "Schmidt", "Rossi", "Russo", "Martin", "Bernard", "González", "Rodríguez",
  ];
  const p = String(pos || "").toUpperCase();
  const isGk = p === "GK";
  // Ana özellikler (mevkiye göre primary sayılır)
  const primary = {
    pace: ["FL", "FR", "ML", "MR", "DL", "DR"].includes(p),
    passing: ["MC", "OMC", "DM", "ML", "MR"].includes(p),
    finishing: ["FC", "FL", "FR", "OMC"].includes(p),
    tackle: ["DC", "DL", "DR", "DM"].includes(p),
    vision: ["MC", "OMC", "DM"].includes(p),
    stamina: ["DM", "MC", "DC", "DL", "DR"].includes(p),
    strength: ["DC", "FC", "DM"].includes(p),
    technique: ["OMC", "MC", "FL", "FR", "FC"].includes(p),
    agility: isGk || ["FL", "FR", "ML", "MR"].includes(p),
    positioning: isGk || ["DC", "DL", "DR", "DM", "FC"].includes(p),
    reflex: isGk,
    handling: isGk,
  };
  const player = {
    id: uid(),
    club_id: clubId,
    name:
      first[Math.floor(Math.random() * first.length)] +
      " " +
      last[Math.floor(Math.random() * last.length)],
    number: idx + 1,
    pos,
    natural_pos: pos,
    age: 18 + Math.floor(Math.random() * 14),
    pace: sk(mods.pace, primary.pace),
    passing: sk(mods.passing, primary.passing),
    finishing: sk(mods.finishing, primary.finishing),
    tackle: sk(mods.tackle, primary.tackle),
    vision: sk(mods.vision, primary.vision),
    stamina: sk(mods.stamina, primary.stamina),
    strength: sk(mods.strength, primary.strength),
    technique: sk(mods.technique, primary.technique),
    agility: sk(mods.agility, primary.agility),
    positioning: sk(mods.positioning, primary.positioning),
    reflex: isGk ? sk(mods.reflex, true) : clampSkill(4 + Math.random() * 2.2),
    handling: isGk ? sk(mods.handling, true) : clampSkill(3.5 + Math.random() * 2),
    condition: 85 + Math.floor(Math.random() * 15),
    form: 0,
    experience: 2 + Math.random() * 5,
    happiness: 70 + Math.floor(Math.random() * 25),
    base_quality: Math.max(1, Math.min(10, Math.round(strength * 0.7 + Math.random() * 2.5))),
    base_potential: Math.max(1, Math.min(10, Math.round(strength * 0.85 + Math.random() * 2.5))),
    is_starter: idx < 11,
    bench_order: idx < 11 ? null : idx - 11,
  };
  if (isGk) {
    player.technique = clampSkill(Math.min(player.technique, 5.5 + strength * 0.25));
    player.finishing = clampSkill(Math.min(player.finishing, 5.5));
  }
  return player;
}

/**
 * Tek bot kulüp oluştur (transaction client opsiyonel).
 */
async function createBotClub(opts = {}) {
  const country = opts.country || "Türkiye";
  const division = opts.division || 1;
  const strength = Math.max(1, Math.min(10, opts.strength || 4 + Math.floor(Math.random() * 4)));

  return withTransaction(async (client) => {
    const { rows: existingNames } = await client.query(
      `SELECT LOWER(name) AS n FROM clubs WHERE country = $1`,
      [country],
    );
    const used = new Set(existingNames.map((r) => r.n));
    const name =
      opts.name ||
      randomName(used, {
        country,
        index:
          opts.nameIndex != null
            ? opts.nameIndex
            : used.size + (opts.division || 1) * 17 + country.length * 3,
      });

    const clubId = uid();
    // user_id NULL + is_bot TRUE (003 migration sonrası)
    await client.query(
      `INSERT INTO clubs (id, user_id, name, country, division, balance, is_bot)
       VALUES ($1, NULL, $2, $3, $4, $5, TRUE)`,
      [clubId, name, country, division, 2_000_000 + strength * 200_000],
    );

    await client.query(
      `INSERT INTO stadiums (club_id, name, capacity, ticket_price)
       VALUES ($1, $2, $3, $4)`,
      [
        clubId,
        name + " Stadium",
        12000 + strength * 2000,
        8 + Math.floor(strength / 2),
      ],
    );

    await client.query(
      `INSERT INTO youth_academy (club_id, scout_level, academy_level)
       VALUES ($1, $2, $2)`,
      [clubId, Math.min(5, 1 + Math.floor(strength / 3))],
    );

    await client.query(
      `INSERT INTO club_coaches (club_id, skill, level, salary, name)
       VALUES ($1, 'stamina', $2, $3, 'Bot Antrenör')`,
      [clubId, Math.min(5, 1 + Math.floor(strength / 2)), 5000 * strength],
    );

    for (let i = 0; i < POSITIONS_18.length; i++) {
      const p = makePlayer(clubId, POSITIONS_18[i], i, strength);
      await client.query(
        `INSERT INTO players (
           id, club_id, name, number, pos, natural_pos, age,
           pace, passing, finishing, tackle, vision, stamina,
           strength, technique, agility, positioning, reflex, handling,
           condition, form, experience, happiness,
           base_quality, base_potential, is_starter, bench_order
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,
           $8,$9,$10,$11,$12,$13,
           $14,$15,$16,$17,$18,$19,
           $20,$21,$22,$23,
           $24,$25,$26,$27
         )`,
        [
          p.id, clubId, p.name, p.number, p.pos, p.natural_pos, p.age,
          p.pace, p.passing, p.finishing, p.tackle, p.vision, p.stamina,
          p.strength, p.technique, p.agility, p.positioning, p.reflex, p.handling,
          p.condition, p.form, p.experience, p.happiness,
          p.base_quality, p.base_potential, p.is_starter, p.bench_order,
        ],
      );
    }

    return { id: clubId, name, country, division, strength, isBot: true };
  });
}

async function countClubs(country, division) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS c FROM clubs WHERE country = $1 AND division = $2`,
    [country, division],
  );
  return rows[0].c;
}

async function countHumanClubs(country, division) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS c FROM clubs
     WHERE country = $1 AND division = $2 AND COALESCE(is_bot, FALSE) = FALSE`,
    [country, division],
  );
  return rows[0].c;
}

/**
 * Ligi targetSize'a tamamla (bot ekle), standings'e yaz, isteğe bağlı fikstür üret.
 */
async function ensureLeagueFilled(opts = {}) {
  const country = opts.country || "Türkiye";
  const division = opts.division || 1;
  const targetSize = Math.max(2, opts.targetSize || 8);
  const generateFixtures = opts.generateFixtures !== false;
  const forceFixtures = !!opts.forceFixtures;

  let current = await countClubs(country, division);
  const need = Math.max(0, targetSize - current);
  const created = [];
  const removed = [];

  // Fazla bot varsa hedefe indir (insan kulüplere dokunma)
  if (current > targetSize) {
    const excess = current - targetSize;
    const { rows: excessBots } = await query(
      `SELECT id, name FROM clubs
       WHERE country = $1 AND division = $2 AND COALESCE(is_bot, FALSE) = TRUE
       ORDER BY created_at DESC NULLS LAST, id DESC
       LIMIT $3`,
      [country, division, excess],
    );
    for (const b of excessBots) {
      try {
        await query(`UPDATE players SET club_id = NULL WHERE club_id = $1`, [b.id]);
        await query(`DELETE FROM league_standings WHERE club_id = $1`, [b.id]).catch(() => {});
        await query(`DELETE FROM clubs WHERE id = $1 AND COALESCE(is_bot, FALSE) = TRUE`, [b.id]);
        removed.push({ id: b.id, name: b.name });
      } catch (e) {
        console.warn("[botClubs] prune bot", b.id, e && e.message);
      }
    }
    current = await countClubs(country, division);
  }

  for (let i = 0; i < need; i++) {
    const strength = 3 + Math.floor(Math.random() * 5);
    // nameIndex: ülke+lig+sıra → benzer isimler (tamamen rastgele değil)
    const bot = await createBotClub({
      country,
      division,
      strength,
      nameIndex: current + i + division * 31 + country.length,
    });
    created.push(bot);
  }

  // Ülkenin bu ligi için aktif sezon yoksa otomatik açılır (yalnızca
  // Türkiye başlangıçta seed edilmişti — diğer ülkeler ilk kayıtta burada
  // sezona kavuşur, aksi halde standings/fikstür hiç oluşmuyordu).
  const season = await leagueRepo.ensureSeason(country, division);
  if (season) {
    const { rows: clubs } = await query(
      `SELECT id FROM clubs WHERE country = $1 AND division = $2`,
      [country, division],
    );
    for (const c of clubs) {
      await leagueRepo.ensureClubInStandings(season.id, c.id);
    }

    // Fikstür: yeni bot / force / veya hiç fikstür yoksa üret
    let shouldFx = generateFixtures && (need > 0 || removed.length > 0 || forceFixtures);
    if (generateFixtures && !shouldFx && season) {
      try {
        const { rows: fc } = await query(
          `SELECT COUNT(*)::int AS c FROM fixtures WHERE season_id = $1`,
          [season.id],
        );
        if (!fc[0] || Number(fc[0].c) === 0) shouldFx = true;
      } catch (_) {
        shouldFx = true;
      }
    }
    if (shouldFx) {
      // forceFixtures yalnızca açıkça true ise scheduled maçları siler/yeniler.
      // need > 0 veya boş fikstür → force YOK: yoksa üretir, varsa dokunmaz.
      const fx = await leagueRepo.generateFixturesForSeason(season.id, {
        force: !!forceFixtures,
        intervalHours: opts.intervalHours,
        intervalMinutes: opts.intervalMinutes,
        doubleRound: opts.doubleRound !== false,
        startAt: opts.startAt,
        bumpPast: opts.bumpPast === true,
      });
      return {
        created: created.length,
        removed: removed.length,
        removedBots: removed,
        bots: created,
        totalClubs: current + created.length,
        fixtures: fx,
        seasonId: season.id,
      };
    }
  }

  return {
    created: created.length,
    removed: removed.length,
    removedBots: removed,
    bots: created,
    totalClubs: current + created.length,
    fixtures: null,
    seasonId: season ? season.id : null,
  };
}

/**
 * Bot takım objesini matchEngine için hazırla (getTeam ile aynı şekil).
 */
async function getBotTeam(clubId) {
  const clubsRepo = require("./repos/clubsRepo");
  return clubsRepo.getTeam(clubId);
}

/**
 * Mevcut kulübün tüm oyuncularını silip 18 kişilik yeni kadro verir.
 * strength 1–10 (insan kulüpleri için ~5–7).
 */
async function regenerateSquad(clubId, strength = 5) {
  const s = Math.max(1, Math.min(10, Number(strength) || 5));
  return withTransaction(async (client) => {
    await client.query(`DELETE FROM players WHERE club_id = $1`, [clubId]);
    for (let i = 0; i < POSITIONS_18.length; i++) {
      const p = makePlayer(clubId, POSITIONS_18[i], i, s);
      await client.query(
        `INSERT INTO players (
           id, club_id, name, number, pos, natural_pos, age,
           pace, passing, finishing, tackle, vision, stamina,
           strength, technique, agility, positioning, reflex, handling,
           condition, form, experience, happiness,
           base_quality, base_potential, is_starter, bench_order
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,
           $8,$9,$10,$11,$12,$13,
           $14,$15,$16,$17,$18,$19,
           $20,$21,$22,$23,
           $24,$25,$26,$27
         )`,
        [
          p.id, clubId, p.name, p.number, p.pos, p.natural_pos, p.age,
          p.pace, p.passing, p.finishing, p.tackle, p.vision, p.stamina,
          p.strength, p.technique, p.agility, p.positioning, p.reflex, p.handling,
          p.condition, p.form, p.experience, p.happiness,
          p.base_quality, p.base_potential, p.is_starter, p.bench_order,
        ],
      );
    }
    return { clubId, players: POSITIONS_18.length, strength: s };
  });
}

/** Tüm kulüpler için kadro yenile (insan + bot). */
async function regenerateAllSquads() {
  const { rows } = await query(
    `SELECT id, COALESCE(is_bot, FALSE) AS is_bot, balance FROM clubs`,
  );
  const out = [];
  for (const c of rows) {
    let strength = 5;
    if (c.is_bot) {
      // bakiye ~ strength tahmini
      strength = Math.max(3, Math.min(9, Math.round(Number(c.balance) / 200000 - 5)));
    } else {
      strength = 5 + Math.floor(Math.random() * 3);
    }
    try {
      out.push(await regenerateSquad(c.id, strength));
    } catch (e) {
      console.warn("[regenerateSquad]", c.id, e.message);
    }
  }
  return { clubs: out.length, details: out };
}

/**
 * Tüm desteklenen ülkeler + 1. (ve varsa 2.) lig için bot + sezon + fikstür.
 * Sunucu açılışında bir kez çağrılır; mevcut fikstüre dokunmaz (force yok).
 */
async function bootstrapAllLeagues(opts = {}) {
  const { SUPPORTED_COUNTRIES } = require("./countries");
  const targetSize = Math.max(4, opts.targetSize || 8);
  const divisions = opts.divisions || [1, 2];
  const countries = opts.countries || SUPPORTED_COUNTRIES;
  const results = [];
  for (const country of countries) {
    for (const division of divisions) {
      try {
        // 2. lig: sadece o ülkede zaten 2. lig kulübü varsa veya forceDiv2
        if (division > 1 && !opts.forceAllDivisions) {
          const n = await countClubs(country, division);
          if (n === 0 && !opts.createEmptyDivisions) {
            // 2. lig boşsa atla (gereksiz 29x8 bot üretme)
            continue;
          }
        }
        const liveLaunch =
          opts.forceFixtures === true ||
          String(process.env.LIVE_LAUNCH || "") === "1";
        const r = await ensureLeagueFilled({
          country,
          division,
          targetSize,
          generateFixtures: true,
          forceFixtures: liveLaunch,
          intervalHours: opts.intervalHours,
          startAt: opts.startAt,
          bumpPast: opts.bumpPast === true || liveLaunch,
        });
        results.push({ country, division, ...r });
        if (r.created || (r.fixtures && r.fixtures.created)) {
          console.log(
            "[botClubs] bootstrap",
            country,
            "L" + division,
            "bots+",
            r.created,
            "fx",
            r.fixtures && (r.fixtures.created || r.fixtures.skipped),
          );
        }
      } catch (e) {
        console.warn("[botClubs] bootstrap", country, division, e.message);
        results.push({ country, division, error: e.message });
      }
    }
  }
  return { ok: true, leagues: results.length, results };
}

module.exports = {
  createBotClub,
  ensureLeagueFilled,
  bootstrapAllLeagues,
  countClubs,
  countHumanClubs,
  getBotTeam,
  makePlayer,
  regenerateSquad,
  regenerateAllSquads,
};
