/** Realistic seed catalog. Prices are listed in rupees here and stored in paise. */
export const CATEGORIES = [
  { slug: 'electronics', name: 'Electronics', description: 'Audio, wearables, smart home and accessories' },
  { slug: 'fashion', name: 'Fashion', description: 'Everyday apparel, footwear and accessories' },
  { slug: 'home-kitchen', name: 'Home & Kitchen', description: 'Cookware, appliances and home essentials' },
  { slug: 'books', name: 'Books', description: 'Bestsellers, tech and personal growth' },
  { slug: 'sports-fitness', name: 'Sports & Fitness', description: 'Gear for training, yoga and the outdoors' },
  { slug: 'beauty', name: 'Beauty & Personal Care', description: 'Skincare, grooming and wellness' },
];

// [category, name, brand, price, compareAt, stock, rating, reviewCount, featured, tags, description, attributes]
const RAW = [
  ['electronics', 'Aurora ANC Wireless Headphones', 'Sonique', 7999, 11999, 42, 4.5, 1284, true, ['headphones', 'bluetooth', 'noise cancelling'], 'Over-ear headphones with hybrid active noise cancellation, 40-hour battery life and fast charging (10 minutes for 5 hours of playback).', { color: 'Midnight Black', battery: '40 hours', connectivity: 'Bluetooth 5.3' }],
  ['electronics', 'Pulse Buds Pro TWS Earbuds', 'Sonique', 3499, 4999, 120, 4.2, 3410, false, ['earbuds', 'bluetooth', 'wireless'], 'True wireless earbuds with ENC mics, IPX5 sweat resistance and low-latency gaming mode.', { color: 'Pearl White', battery: '32 hours with case', waterResistance: 'IPX5' }],
  ['electronics', 'Vertex Smartwatch S2', 'Kinetiq', 5499, 7999, 65, 4.1, 892, true, ['smartwatch', 'fitness', 'wearable'], '1.43" AMOLED display, SpO2 and heart-rate tracking, 100+ sport modes and Bluetooth calling.', { display: '1.43" AMOLED', battery: '7 days', strap: 'Silicone' }],
  ['electronics', 'Volt 20000mAh Power Bank', 'Voltix', 1799, 2499, 200, 4.4, 5021, false, ['power bank', 'charging', 'usb-c'], '22.5W fast charging power bank with USB-C PD input/output and triple device charging.', { capacity: '20000mAh', output: '22.5W', ports: 'USB-C, 2x USB-A' }],
  ['electronics', 'Lumen 4K Streaming Stick', 'Lumen', 4499, null, 38, 4.3, 610, false, ['streaming', '4k', 'tv'], 'Stream in 4K HDR with Dolby Atmos support and a voice remote with app shortcuts.', { resolution: '4K HDR', wifi: 'Wi-Fi 6' }],
  ['electronics', 'Echoes Portable Bluetooth Speaker', 'Sonique', 2999, 3999, 4, 4.6, 742, false, ['speaker', 'bluetooth', 'portable'], 'Rugged IP67 speaker with 360° sound, 20-hour battery and stereo pairing.', { waterResistance: 'IP67', battery: '20 hours' }],
  ['electronics', 'Halo Smart LED Bulb (Pack of 2)', 'Lumen', 1299, 1599, 150, 4.0, 2210, false, ['smart home', 'lighting', 'wifi'], '9W Wi-Fi bulbs with 16 million colours, schedules and voice assistant support.', { wattage: '9W', pack: '2 bulbs' }],
  ['fashion', "Men's Classic Oxford Shirt", 'Threadline', 1499, 2199, 80, 4.2, 455, false, ['shirt', 'cotton', 'formal'], 'Breathable 100% cotton Oxford shirt with a tailored fit and button-down collar.', { material: '100% Cotton', fit: 'Slim', sizes: 'S, M, L, XL' }],
  ['fashion', "Women's Everyday Running Shoes", 'Stride', 2799, 3999, 55, 4.4, 1320, true, ['shoes', 'running', 'sports'], 'Lightweight knit upper, responsive foam cushioning and a grippy rubber outsole.', { weight: '220g', sizes: 'UK 3-8' }],
  ['fashion', 'Unisex Canvas Backpack 25L', 'Nomad Co.', 1899, 2499, 90, 4.5, 2034, false, ['backpack', 'travel', 'laptop bag'], 'Water-resistant canvas backpack with padded 15.6" laptop sleeve and hidden anti-theft pocket.', { capacity: '25L', laptop: 'Up to 15.6"' }],
  ['fashion', 'Polarised Aviator Sunglasses', 'Solace', 1199, 1999, 0, 4.1, 389, false, ['sunglasses', 'uv protection'], 'Metal-frame aviators with polarised UV400 lenses and a hard carry case.', { lens: 'Polarised UV400', frame: 'Metal' }],
  ['fashion', "Men's Slim Fit Stretch Jeans", 'Threadline', 1999, 2999, 70, 4.3, 980, false, ['jeans', 'denim'], 'Mid-rise slim jeans in stretch denim that holds its shape all day.', { material: '98% Cotton, 2% Elastane', fit: 'Slim' }],
  ['fashion', 'Leather Minimalist Wallet', 'Nomad Co.', 899, 1299, 140, 4.6, 1502, false, ['wallet', 'leather', 'rfid'], 'Full-grain leather bifold with RFID blocking and space for 8 cards.', { material: 'Full-grain leather', rfid: 'Yes' }],
  ['home-kitchen', 'Tri-Ply Stainless Steel Kadai 24cm', 'Hearthware', 2299, 2999, 48, 4.6, 812, true, ['cookware', 'kadai', 'induction'], 'Tri-ply construction for even heating; works on gas and induction. Includes glass lid.', { diameter: '24cm', compatibility: 'Gas & Induction' }],
  ['home-kitchen', 'Digital Air Fryer 4.2L', 'Hearthware', 5999, 8999, 30, 4.4, 2760, true, ['air fryer', 'appliance'], '1500W air fryer with 8 presets, rapid air circulation and a dishwasher-safe basket.', { capacity: '4.2L', power: '1500W' }],
  ['home-kitchen', 'Cold Brew Coffee Maker 1L', 'Brewcraft', 1499, null, 60, 4.2, 214, false, ['coffee', 'cold brew'], 'Borosilicate glass carafe with a fine-mesh stainless filter for smooth cold brew.', { capacity: '1L', material: 'Borosilicate glass' }],
  ['home-kitchen', 'Bamboo Chopping Board Set (3 pcs)', 'Verdant', 999, 1499, 110, 4.3, 640, false, ['chopping board', 'bamboo'], 'Sustainable bamboo boards in three sizes with juice grooves.', { pieces: '3', material: 'Bamboo' }],
  ['home-kitchen', 'Vacuum Insulated Water Bottle 1L', 'Verdant', 849, 1199, 3, 4.5, 3120, false, ['bottle', 'insulated', 'steel'], 'Keeps drinks cold for 24 hours or hot for 12. Leak-proof lid.', { capacity: '1L', insulation: 'Double wall' }],
  ['home-kitchen', 'Cotton Bedsheet Set — Queen', 'Dreamweave', 1799, 2599, 45, 4.1, 498, false, ['bedsheet', 'cotton', 'bedroom'], '300 thread count percale cotton set with one flat sheet and two pillow covers.', { size: 'Queen', threadCount: '300' }],
  ['books', 'Designing Data-Intensive Systems (Paperback)', 'Ledger Press', 1299, 1599, 75, 4.8, 2210, true, ['programming', 'distributed systems', 'databases'], 'A practical guide to the principles behind reliable, scalable and maintainable data systems.', { pages: '612', format: 'Paperback', language: 'English' }],
  ['books', 'The Pragmatic Deployer', 'Ledger Press', 899, null, 40, 4.6, 530, false, ['devops', 'cloud', 'programming'], 'Field-tested patterns for shipping software safely: CI/CD, observability and incident response.', { pages: '384', format: 'Paperback' }],
  ['books', 'Atomic Routines', 'Northstar Books', 499, 699, 160, 4.7, 8840, false, ['self help', 'habits'], 'How tiny daily changes compound into remarkable results.', { pages: '320', format: 'Paperback' }],
  ['books', 'Monsoon Stories: An Anthology', 'Northstar Books', 399, null, 25, 4.3, 310, false, ['fiction', 'short stories', 'indian authors'], 'Twelve short stories by contemporary Indian writers set across one rainy season.', { pages: '256', format: 'Paperback' }],
  ['books', 'JavaScript: From Fundamentals to Node', 'Ledger Press', 749, 999, 0, 4.4, 640, false, ['programming', 'javascript', 'node'], 'A hands-on path from language basics to building production Node.js services.', { pages: '480', format: 'Paperback' }],
  ['sports-fitness', 'Anti-Slip Yoga Mat 6mm', 'Asana', 1199, 1799, 85, 4.5, 4120, true, ['yoga', 'mat', 'fitness'], 'Dual-texture TPE mat with alignment lines and a carry strap.', { thickness: '6mm', material: 'TPE' }],
  ['sports-fitness', 'Adjustable Dumbbell Set 20kg', 'IronCore', 4999, 6499, 20, 4.3, 760, false, ['dumbbells', 'strength', 'home gym'], 'Chrome-plated adjustable dumbbells with spin-lock collars. 20kg total.', { weight: '20kg total', material: 'Cast iron' }],
  ['sports-fitness', 'Resistance Bands Set (5 levels)', 'IronCore', 799, 1199, 130, 4.2, 1850, false, ['resistance bands', 'workout'], 'Five latex bands from extra-light to extra-heavy with handles, ankle straps and door anchor.', { levels: '5' }],
  ['sports-fitness', 'Kashmir Willow Cricket Bat', 'Crease', 2499, 3299, 18, 4.4, 402, false, ['cricket', 'bat'], 'Full-size Kashmir willow bat with a thick edge and a cane handle for shock absorption.', { size: 'Full (SH)', weight: '1.1-1.2kg' }],
  ['sports-fitness', 'Trail Hiking Daypack 30L', 'Nomad Co.', 2199, 2999, 35, 4.5, 288, false, ['hiking', 'backpack', 'outdoors'], 'Ventilated back panel, hydration sleeve and integrated rain cover.', { capacity: '30L', rainCover: 'Included' }],
  ['beauty', 'Vitamin C Brightening Serum 30ml', 'Lumiere', 699, 899, 140, 4.3, 5600, true, ['skincare', 'serum', 'vitamin c'], '10% vitamin C with hyaluronic acid for brighter, even-toned skin.', { volume: '30ml', skinType: 'All' }],
  ['beauty', 'SPF 50 Gel Sunscreen 50g', 'Lumiere', 449, null, 220, 4.4, 7200, false, ['sunscreen', 'spf', 'skincare'], 'Lightweight, non-greasy PA++++ sunscreen with no white cast.', { spf: '50', size: '50g' }],
  ['beauty', 'Beard Grooming Kit', 'Barber & Co.', 999, 1499, 60, 4.2, 870, false, ['grooming', 'beard', 'men'], 'Beard oil, balm, wooden comb and boar bristle brush in a gift box.', { contents: 'Oil, balm, comb, brush' }],
  ['beauty', 'Cordless Hair Trimmer T9', 'Barber & Co.', 1599, 2299, 75, 4.1, 2310, false, ['trimmer', 'grooming'], 'Stainless steel blades, 40 length settings and 90 minutes of cordless runtime.', { runtime: '90 minutes', settings: '40' }],
  ['beauty', 'Aloe & Cucumber Face Wash 150ml', 'Verdant', 299, 399, 300, 4.0, 3900, false, ['face wash', 'skincare'], 'Gentle soap-free cleanser that hydrates while removing oil and dirt.', { volume: '150ml' }],
];

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[—–]/g, '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export function buildSeedProducts() {
  const base = Date.parse('2026-03-01T08:00:00.000Z');
  return RAW.map(([category, name, brand, price, compareAt, stock, rating, reviewCount, featured, tags, description, attributes], i) => {
    const n = String(i + 1).padStart(4, '0');
    const createdAt = new Date(base + i * 36 * 3_600_000).toISOString();
    return {
      id: `prd_${n}`,
      sku: `${category.slice(0, 3).toUpperCase()}-${n}`,
      slug: slugify(name),
      name,
      brand,
      category,
      description,
      price: price * 100,
      compareAtPrice: compareAt ? compareAt * 100 : null,
      currency: 'INR',
      stock,
      rating,
      reviewCount,
      featured,
      tags,
      attributes,
      status: 'active',
      createdAt,
      updatedAt: createdAt,
    };
  });
}

export const SEED_REVIEWS = [
  ['prd_0001', 'usr_seed_jane', 'Jane Doe', 5, 'Silence on the metro', 'ANC is excellent for the price. Battery easily lasts my whole work week of commuting.'],
  ['prd_0001', 'usr_seed_rahul', 'Rahul Sharma', 4, 'Great sound, tight fit', 'Sound is rich and balanced. Clamping force is a bit strong for the first few days.'],
  ['prd_0003', 'usr_seed_rahul', 'Rahul Sharma', 4, 'Good value smartwatch', 'Accurate step and heart-rate tracking. The companion app could be better.'],
  ['prd_0009', 'usr_seed_jane', 'Jane Doe', 5, 'My go-to running shoes', 'Very light and comfortable for 10k runs. Sizing is true to UK sizes.'],
  ['prd_0015', 'usr_seed_jane', 'Jane Doe', 4, 'Crispy without the oil', 'Makes perfect fries and paneer tikka. Basket is easy to clean.'],
  ['prd_0020', 'usr_seed_rahul', 'Rahul Sharma', 5, 'Required reading', 'Every backend engineer should read this. Dense but worth every page.'],
  ['prd_0025', 'usr_seed_jane', 'Jane Doe', 5, 'Does not slip at all', 'Grippy even in hot yoga sessions and the alignment lines are helpful.'],
  ['prd_0030', 'usr_seed_rahul', 'Rahul Sharma', 4, 'Visible results', 'Skin looks brighter after three weeks. Slight tingling at first.'],
];
