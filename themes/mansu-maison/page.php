<?php
/**
 * Pages, including Cart, Checkout and My account (WooCommerce renders their content).
 * Pages built with Elementor keep working: Elementor replaces the_content().
 *
 * @package Mansu_Maison
 */

defined( 'ABSPATH' ) || exit;
get_header();
$is_wc_page = function_exists( 'is_cart' ) && ( is_cart() || is_checkout() || is_account_page() );
?>
<main id="main" class="<?php echo $is_wc_page ? 'wrap page-main wc-page' : 'page-main'; ?>">
	<?php
	while ( have_posts() ) :
		the_post();
		$elementor = did_action( 'elementor/loaded' ) && class_exists( '\Elementor\Plugin' ) && \Elementor\Plugin::$instance->documents->get( get_the_ID() ) && \Elementor\Plugin::$instance->documents->get( get_the_ID() )->is_built_with_elementor();
		?>
		<article <?php post_class(); ?>>
			<?php if ( ! $elementor ) : ?>
				<header class="shop-head<?php echo $is_wc_page ? '' : ' wrap'; ?>"><div class="rule" aria-hidden="true"></div><h1 class="page-title"><?php the_title(); ?></h1></header>
				<div class="<?php echo $is_wc_page ? '' : 'wrap prose'; ?>"><?php the_content(); ?></div>
			<?php else : ?>
				<?php the_content(); ?>
			<?php endif; ?>
		</article>
	<?php endwhile; ?>
</main>
<?php
get_footer();
